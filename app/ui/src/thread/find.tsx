import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Older, Paged } from "../daemon";
import { FindBar } from "./find-bar";
import { clippedBy, covered, findInThread, firstBelow, isRange, itemOf, NOTHING, olderAt, sameHit, withOlder, type Away, type Found, type Row } from "./find-hits";
import { findLabel, lower, MAX_RESULTS, paint, startSearching, unpaint } from "./find-text";
import { setKept } from "./kept";
import type { Item, Session } from "./item";

/*
 * Find in the conversation [D470], the old app's [D48]: ⌘F opens a bar at the thread's top right that finds text, case
 * aside, in what the thread shows. Every match is washed yellow and the one gone to orange. Enter, ⌘G and › go to the
 * next, ⇧Enter, ⇧⌘G and ‹ the one before, Esc closes. Rows the list hasn't drawn are found in what they showed when
 * last drawn, or else their words (find-text.ts); a closed work fold or group counts its steps' words, and going to
 * one (a step, never typing) opens it. Rows not loaded are counted by Rust ahead of the thread's own; going to one
 * loads the pages down to it. Proposed: a line beside the count says while those can't be counted.
 */

/** What find reads and asks of the source: the session, its older pages, and Rust's count of the rows not loaded. */
export type FindSource = { get(): Session | null; older?(): Promise<Paged> | void; findOlder?(query: string, limit: number): Promise<Older> };

const RERUN_MS = 150;
const OLDER_MS = 150;
const OLDER_PAGES = 50;
const STILL_FRAMES = 3;
const LAST_FRAME = 300;
const CLEAR_PX = 16;
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Where a key press belongs to something else (a terminal, another tab, a dialog or menu), as the old app's. */
const ELSEWHERE = '[role="tabpanel"], .xterm, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** ⌘ and `code` (Ctrl off macOS). */
function command(event: KeyboardEvent, code: string): boolean {
  const mac = navigator.platform.startsWith("Mac");
  const held = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return held && !event.altKey && event.code === code && !event.isComposing;
}

export type FindProps = {
  source: FindSource;
  /** The list's scroller. */
  scroller: () => HTMLElement | null;
  rows: readonly Row[];
  items: readonly Item[];
  /** Opens these groups and work folds. */
  onOpen: (ids: readonly string[]) => void;
  /** Stops following the end and brings row `index` to the top. */
  toIndex: (index: number) => void;
  /** Stops following the end, before a scroll of find's own. */
  away: () => void;
};

/** The bar, over the thread's top right. */
export function Find(props: FindProps) {
  const { source, scroller } = props;
  const now = useRef(props);
  now.current = props;
  const cursor = source.get()?.before ?? null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<Found>(NOTHING);
  const [active, setActive] = useState(-1);
  const [olderState, setOlderState] = useState<"searching" | "offline" | "failed" | null>(null);
  const [focusAsk, setFocusAsk] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const before = useRef<Element | null>(null);
  const reveals = useRef(0);
  /** The kept keys of the "Show more"s find opened, folded back on closing unless the user toggled them since. */
  const expanded = useRef(new Set<string>());
  const toggling = useRef(false);
  const texts = useRef(new Map<string, { text: string; line: Row }>());
  const older = useRef<({ needle: string } & Extract<Older, { ok: true }>) | null>(null);
  const loading = useRef<{ index: number; all: number } | null>(null);
  const state = useRef({ open, query, result, active });
  useLayoutEffect(() => {
    state.current = { open, query, result, active };
  });
  const choose = useCallback((index: number) => {
    state.current.active = index;
    setActive(index);
  }, []);
  const rowsNow = () => now.current.rows;
  /** What a row not drawn showed when last drawn, while it is the same row. */
  const textOf = (line: Row) => {
    const kept = texts.current.get(line.id);
    return kept && kept.line === line ? kept.text : undefined;
  };

  /** Searches for `text`; `fresh` (a new text) goes to the first match from the view's top, never opening anything. */
  const run = (text: string, fresh: boolean): Found => {
    const { result: last, active: at } = state.current;
    const root = now.current.scroller();
    const read = new Map<string, { text: string; line: Row }>();
    const needle = lower(text);
    const found = withOlder(root ? findInThread(root, rowsNow(), now.current.items, needle, textOf, read) : NOTHING, older.current, needle, now.current.source.get()?.before ?? null);
    for (const [id, kept] of read) texts.current.set(id, kept);
    const count = found.before + found.ranges.length;
    if (fresh) {
      reveals.current++;
      loading.current = null;
    }
    const load = loading.current;
    // Pages loaded for a step aren't drawn yet: the bar keeps what it showed until they are.
    if (load && count < load.all) return found;
    state.current.result = found;
    setResult(found);
    if (load) {
      choose(Math.min(load.index, count - 1));
      return found;
    }
    if (count === 0) {
      choose(-1);
      return found;
    }
    if (fresh || at < 0) {
      if (found.ranges.length > 0 && root) goTo(found.before + firstBelow(root, rowsNow(), found.ranges), found, false);
      else choose(found.before - 1);
      return found;
    }
    // The thread changed under the bar: the match gone to stays, where it still is.
    const kept = last.ranges[at - last.before];
    const same = kept ? found.ranges.findIndex((hit) => sameHit(hit, kept)) : -1;
    const index = same >= 0 ? found.before + same : at < last.before ? at : at - last.before + found.before;
    choose(Math.max(0, Math.min(index, count - 1)));
    return found;
  };
  const research = () => run(state.current.query, false);
  const later = useRef(research);
  later.current = research;

  /** Brings `match` into view between the bar and the thread's bottom, opening a "Show more" over it when `opens`. */
  const reveal = async (match: Range, opens: boolean) => {
    const root = now.current.scroller();
    if (!root) return;
    const seq = ++reveals.current;
    const live = () => seq === reveals.current && root.isConnected && match.startContainer.isConnected;
    // A cut inside a cut (a folded code block in a long message): each opens in turn.
    for (let more = clippedBy(match), tries = 0; more && tries < 3; more = clippedBy(match), tries++) {
      if (!opens) return;
      if (more.dataset.kept) expanded.current.add(more.dataset.kept);
      toggling.current = true;
      more.click();
      toggling.current = false;
      for (let frames = 0; frames < 30 && live() && more.getAttribute("aria-expanded") !== "true"; frames++) await nextFrame();
      await nextFrame();
      if (!live()) return;
    }
    now.current.away();
    const box = root.getBoundingClientRect();
    const top = Math.max(box.top, bar.current?.getBoundingClientRect().bottom ?? box.top) + CLEAR_PX;
    const bottom = Math.max(top, box.bottom - CLEAR_PX);
    // A box scrolling on its own (a command's output, an opened group's steps) brings it to its middle first.
    for (let own = match.startContainer.parentElement; own && own !== root && root.contains(own); own = own.parentElement) {
      if (own.scrollHeight <= own.clientHeight + 1 || !/auto|scroll/.test(getComputedStyle(own).overflowY)) continue;
      const sides = own.getBoundingClientRect();
      const at = match.getBoundingClientRect();
      if (at.top < sides.top || at.bottom > sides.bottom) own.scrollTop += at.top - sides.top - (sides.height - at.height) / 2;
    }
    const rect = match.getBoundingClientRect();
    const pre = match.startContainer.parentElement?.closest("pre");
    if (pre && pre.scrollWidth > pre.clientWidth) {
      const sides = pre.getBoundingClientRect();
      if (rect.left < sides.left || rect.right > sides.right) pre.scrollLeft += rect.left - sides.left - sides.width / 2;
    }
    if (rect.top >= top && rect.bottom <= bottom) return;
    const aim = () => {
      const max = Math.max(0, root.scrollHeight - root.clientHeight);
      const at = match.getBoundingClientRect();
      return Math.round(Math.max(0, Math.min(max, root.scrollTop + at.top + at.height / 2 - (top + bottom) / 2)));
    };
    root.scrollTo({ top: aim(), behavior: reduced() || document.hidden ? "instant" : "smooth" });
    // Rows drawn on the way at their own heights move the match: once the view rests, it lands where it should.
    for (let tries = 0; tries < 3; tries++) {
      let last = root.scrollTop;
      for (let still = 0, frames = 0; still < STILL_FRAMES && frames < 120 && live(); frames++) {
        await nextFrame();
        still = root.scrollTop === last ? still + 1 : 0;
        last = root.scrollTop;
      }
      if (!live() || Math.abs(aim() - root.scrollTop) <= 1) return;
      now.current.away();
      root.scrollTo({ top: aim(), behavior: "instant" });
    }
  };

  /** The row drawing `item`: its own line, or the opened group holding it as a step. */
  const holder = (item: string) => rowsNow().findIndex((row) => row.id === item || (row.type === "group" && row.steps.some((step) => step.id === item)));

  /** Goes to `hit` in a row not drawn or a closed fold: opened (a step only), drawn, still, then found there again. */
  const bring = async (hit: Away, opens: boolean) => {
    const root = now.current.scroller();
    if (!root || (hit.folded && !opens)) return;
    const seq = ++reveals.current;
    const live = () => seq === reveals.current && root.isConnected;
    if (hit.folded && hit.item) {
      const line = rowsNow().find((row) => row.id === hit.row);
      const target = now.current.items.find((item) => item.id === hit.item);
      const group = line && target ? covered(line, now.current.items).find((each) => each.kind === "group" && target.n !== undefined && target.n >= each.span[0] && target.n <= each.span[1]) : undefined;
      now.current.onOpen(group ? [hit.row, group.id] : [hit.row]);
      for (let frames = 0; frames < 60 && live() && holder(hit.item) < 0; frames++) await nextFrame();
      if (!live()) return;
    }
    const index = hit.item ? holder(hit.item) : rowsNow().findIndex((row) => row.id === hit.row);
    if (index < 0) return;
    const selector = `[data-item="${CSS.escape(rowsNow()[index]!.id)}"]`;
    now.current.toIndex(index);
    let last: number | null = null;
    let still = 0;
    for (let frames = 0; frames < 120 && live(); frames++) {
      await nextFrame();
      const row = root.querySelector(selector);
      if (!row) continue;
      const box = (hit.item && hit.item !== rowsNow()[index]!.id && row.querySelector(`[data-step="${CSS.escape(hit.item)}"]`)) || row;
      const top = box.getBoundingClientRect().top;
      still = top === last ? still + 1 : 0;
      last = top;
      if (still < STILL_FRAMES - 1) continue;
      const found = research();
      const mine = found.ranges.filter((each): each is Range => isRange(each) && box.contains(each.startContainer));
      const range = mine[mine.length - 1 - hit.back] ?? mine[0];
      if (!range) return;
      choose(found.before + found.ranges.indexOf(range));
      return void reveal(range, opens);
    }
  };

  /** Goes to match `index`, one in the rows not loaded: the pages down to its row load, then it is found in that row. */
  const loadTo = async (index: number, found: Found) => {
    const target = olderAt(found, index);
    const page = now.current.source.older;
    if (!target || !page) return;
    const seq = ++reveals.current;
    const live = () => seq === reveals.current;
    const mine = { index, all: found.before + found.ranges.length };
    loading.current = mine;
    const done = () => loading.current === mine && (loading.current = null);
    for (let pages = 0; pages < OLDER_PAGES; pages++) {
      const held = now.current.source.get()?.before ?? null;
      if (held === null || held <= target.n) break;
      const paged = await page();
      if (!live()) return void done();
      if (!paged || !paged.ok) {
        setOlderState(paged?.error === "disconnected" || paged?.error === "stale" ? "offline" : "failed");
        return void done();
      }
    }
    // Once the thread holds the row and finds its matches: the same one of them, counted from its last.
    for (let frames = 0; frames <= LAST_FRAME && live(); frames++) {
      await nextFrame();
      const item = now.current.items.find((each) => each.n === target.n)?.id;
      const found = research();
      const theirs = item ? found.ranges.filter((hit) => itemOf(hit) === item) : [];
      if (theirs.length === 0 && frames < LAST_FRAME) continue;
      done();
      const hit = theirs[theirs.length - 1 - target.back] ?? theirs[0];
      return goTo(found.before + (hit ? found.ranges.indexOf(hit) : 0), found, true);
    }
    done();
  };

  /** Match `index` is the one gone to; `opens` (a step) goes there, opening and loading what it must. */
  const goTo = (index: number, found: Found, opens: boolean) => {
    choose(index);
    if (index < found.before) return void (opens && loadTo(index, found));
    const hit = found.ranges[index - found.before];
    if (isRange(hit)) void reveal(hit, opens);
    else if (hit) void bring(hit, opens);
  };

  /** The match after (`1`) or before (`-1`), round from the last to the first. */
  const step = (by: 1 | -1) => {
    const { result: found, active: at } = state.current;
    const count = found.before + found.ranges.length;
    if (count === 0) return;
    // The match typing went to is in the rows not loaded or a closed fold: this step goes there first.
    const current = found.ranges[at - found.before];
    if ((at >= 0 && at < found.before) || (current && !isRange(current) && current.folded)) goTo(at, found, true);
    else goTo((at + by + count) % count, found, true);
  };
  const stepRef = useRef(step);
  stepRef.current = step;

  const close = () => {
    reveals.current++;
    setOpen(false);
    setResult(NOTHING);
    choose(-1);
    const root = now.current.scroller();
    unpaint(root);
    // Folding back what find opened keeps the row at the top where it is.
    const rows = root ? [...root.querySelectorAll<HTMLElement>("[data-item]")] : [];
    const box = root?.getBoundingClientRect();
    const anchor = box && rows.find((row) => row.getBoundingClientRect().bottom > box.top);
    const was = anchor?.getBoundingClientRect().top;
    toggling.current = true;
    for (const key of expanded.current) {
      const more = root?.querySelector<HTMLButtonElement>(`button[data-kept="${CSS.escape(key)}"]`);
      if (!more) setKept(key, false);
      else if (more.getAttribute("aria-expanded") === "true") more.click();
    }
    toggling.current = false;
    if (expanded.current.size > 0 && root && anchor && was !== undefined) {
      expanded.current.clear();
      requestAnimationFrame(() => {
        if (!anchor.isConnected) return;
        now.current.away();
        root.scrollBy({ top: anchor.getBoundingClientRect().top - was, behavior: "instant" });
      });
    }
    expanded.current.clear();
    const back = before.current;
    before.current = null;
    if (back instanceof HTMLElement && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
  };

  /** ⌘F: opens the bar or takes the focus back to it, a one-line selection in the thread as its text. */
  const openFind = () => {
    const root = now.current.scroller();
    const selection = getSelection();
    let text = state.current.query;
    if (root && selection && !selection.isCollapsed && root.contains(selection.anchorNode) && root.contains(selection.focusNode)) {
      const picked = selection.toString().trim();
      text = /[\r\n]/.test(picked) ? "" : picked;
    }
    const fresh = !state.current.open || text !== state.current.query;
    setQuery(text);
    state.current.query = text;
    if (fresh) run(text, true);
    if (!state.current.open) {
      const focused = document.activeElement;
      before.current = focused && !bar.current?.contains(focused) ? focused : null;
      setOpen(true);
    }
    setFocusAsk((ask) => ask + 1);
  };
  const openRef = useRef(openFind);
  openRef.current = openFind;

  // ⌘F anywhere the thread is in front, and ⌘G / ⇧⌘G while the bar is open.
  useEffect(() => {
    const finds = (target: EventTarget | null) => {
      const root = now.current.scroller();
      if (!root?.isConnected || root.clientHeight === 0 || root.closest("[inert]")) return false;
      return !(target instanceof Element && target.closest(ELSEWHERE));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const g = command(event, "KeyG") && state.current.open;
      if (!(command(event, "KeyF") && !event.shiftKey) && !g) return;
      if (!finds(event.target)) return;
      event.preventDefault();
      if (g) stepRef.current(event.shiftKey ? -1 : 1);
      else openRef.current();
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, []);

  useLayoutEffect(() => {
    if (focusAsk === 0) return;
    input.current?.focus();
    input.current?.select();
  }, [focusAsk]);

  // While the bar is open the thread's changes are searched again a moment after they come: the rows drawn, and
  // what streams in.
  const rerunSoon = useRef<() => void>(() => {});
  useEffect(() => {
    const root = scroller();
    if (!open || !root) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    rerunSoon.current = () => {
      timer ??= setTimeout(() => {
        timer = null;
        later.current();
      }, RERUN_MS);
    };
    const observer = new MutationObserver(() => rerunSoon.current());
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributeFilter: ["open"] });
    // A "Show more" the user folds back themselves stays so.
    const clicked = (event: MouseEvent) => {
      const more = !toggling.current && event.target instanceof Element ? event.target.closest<HTMLElement>("button[data-kept]") : null;
      if (more) expanded.current.delete(more.dataset.kept!);
    };
    root.addEventListener("click", clicked, true);
    return () => {
      observer.disconnect();
      root.removeEventListener("click", clicked, true);
      rerunSoon.current = () => {};
      if (timer) clearTimeout(timer);
    };
  }, [open, scroller]);
  useEffect(() => rerunSoon.current(), [props.rows, props.items]);

  // A text resting in the bar: Rust counts the rows not loaded, and the bar counts them with the thread's own. Out of
  // reach, it asks again once the session comes back.
  const ask = source.findOlder;
  // Asked again when the rows held start elsewhere (a page loaded, a reconnect's snapshot), and after an answer that
  // couldn't come once the session changes again.
  const retry = olderState === "offline" || olderState === "failed" ? props.items : null;
  useEffect(() => {
    if (!open || query === "" || !ask || cursor === null) {
      older.current = null;
      setOlderState(null);
      return;
    }
    let current = true;
    // A text already counted refreshes quietly.
    if (older.current?.needle !== lower(query)) setOlderState("searching");
    const timer = setTimeout(() => {
      void ask(query, MAX_RESULTS).then((found) => {
        if (!current) return;
        if (!found.ok) return setOlderState(["disconnected", "stale", "loading"].includes(found.error) ? "offline" : "failed");
        older.current = { needle: lower(query), ...found };
        setOlderState(null);
        later.current();
      });
    }, OLDER_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, query, ask, cursor, retry]);

  // A text in the bar: folded code blocks draw all their lines, cut to their fold, to be found.
  const hasText = open && query !== "";
  useEffect(() => (hasText ? startSearching() : undefined), [hasText]);
  useLayoutEffect(() => {
    const root = scroller();
    if (!open || !root) return;
    const hit = result.ranges[active - result.before];
    paint(root, result.ranges.filter(isRange), isRange(hit) ? hit : null);
  }, [open, result, active, scroller]);
  useEffect(() => () => unpaint(now.current.scroller()), []);

  if (!open) return null;
  const count = result.before + result.ranges.length;
  return (
    <FindBar
      bar={bar}
      input={input}
      query={query}
      label={query === "" ? null : findLabel(active, count, result.more)}
      older={olderState}
      none={count === 0}
      onQuery={(text) => {
        setQuery(text);
        state.current.query = text;
        run(text, true);
      }}
      onStep={step}
      onClose={close}
    />
  );
}
