import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { VList, type VListHandle } from "virtua";

import type { Session } from "./item";
import { lineMaker, type Line } from "./lines";
import { LineRow } from "./rows";
import { ScrollFade } from "../components/scroll-fade";
import { JumpSign, messageMarks } from "../components/thread/message";

/** Where the session comes from: null while it loads. */
export type Source = { subscribe(listener: () => void): () => void; get(): Session | null; older?(): void };
/** `sent(id)`: this window sent the message under this row or command id, so it pins. */
export type ThreadHandle = { toBottom(): void; toIndex(index: number): void; scrollBy(offset: number): void; sent(id: string): void };

/** How close to the end, in px, still counts as at the bottom. */
const NEAR_END = 2;
/** How long after the user's wheel, key or press a scroll still counts as theirs (smooth scrolling runs on). */
const BY_HAND_MS = 500;
/** After the last row: the working line, then space so the last row clears the bottom fade. */
const FOOTER = { type: "footer", id: "footer" } as const;

/** The blank space (px) under a new message that its reply grows into, in its own store so only the spacer redraws. */
function spaceStore() {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: number) {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
type Space = ReturnType<typeof spaceStore>;

/** The space itself: an empty svg as tall as it, since our code sets no inline styles (D68). */
function Spacer({ space }: { space: Space }) {
  const height = useSyncExternalStore(space.subscribe, space.get);
  return height > 0 ? <svg aria-hidden className="block" width="1" height={height} /> : null;
}

/**
 * The session's rows, virtualised, with groups and finished turns' work closed until opened; it follows the bottom
 * while the user is there. `footer` goes under the last row (the working line). A new user message moves near the
 * top with blank space below that its reply grows into; scrolling up gives that space up for good.
 */
export function Thread({ source, footer, ref }: { source: Source; footer?: ReactNode; ref?: Ref<ThreadHandle> }) {
  const session = useSyncExternalStore(source.subscribe, source.get);
  const list = useRef<VListHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const scrolledTo = useRef(0);
  // When the user last moved the list by hand (Infinity while a pointer is down): only that gives up a pin's space,
  // never Virtua's own offset changes as rows arriving above get measured.
  const byHand = useRef(-Infinity);
  const hand = () => (byHand.current = Math.max(byHand.current, performance.now()));
  const [away, setAway] = useState(false);
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  // Opened groups and work folds: view state only, gone with the view.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    // What the user opens stays where it is instead of the list following the bottom.
    stuck.current = false;
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const turnList = session?.turns;
  const workList = session?.work;
  const turns = useMemo(() => new Map(turnList?.map((turn) => [turn.id, turn])), [turnList]);
  const work = useMemo(() => new Map(workList?.map((each) => [each.turnId, each])), [workList]);
  const items = session?.items;
  const lines = useMemo(lineMaker, []);
  const marks = useMemo(() => messageMarks(items ?? []), [items]);
  const threadRows = useMemo(() => (items ? lines(items, turns, work, open) : []), [lines, items, turns, work, open]);
  const setup = session?.setup;
  const all = useMemo(() => {
    const rows = threadRows;
    if (!setup) return rows;
    const at = setup.before === null ? rows.length : rows.findIndex((row) => row.id === setup.before);
    if (at < 0) return rows;
    const line: Line = { type: "setup", id: `${session.id}:setup:${setup.before ?? "tail"}`, gap: at === 0 ? "first" : "turn", setup };
    return [...rows.slice(0, at), line, ...rows.slice(at)];
  }, [threadRows, setup, session?.id]);
  // Older rows arriving above: Virtua keeps what is on screen in place when told the list grew at its start, but until
  // its next scroll end it holds every resize to the list's end, so a row growing below would move the screen. So when
  // rows arrive above, everything stays as drawn for one painted frame, in which Virtua measures what was drawn before
  // they came; then they go in, and the rows from the old first on stay as drawn until Virtua's scroll end, the only
  // place it leaves that mode. Virtua is pinned at 0.54.2: an upgrade must re-run the prepend and both-ends checks.
  const drawn = useRef<readonly Line[]>([]);
  const held = useRef<readonly Line[] | null>(null);
  // Older rows waiting for a painted frame: false while they wait, true once it has passed.
  const ripe = useRef<boolean | null>(null);
  const scrolled = useRef(0);
  const wait = useRef<ReturnType<typeof setTimeout>>(undefined);
  const before = drawn.current[0]?.id;
  const above = before !== undefined && all[0]?.id !== before && all.some((line) => line.id === before);
  const shift = above && ripe.current === true;
  const frozen = held.current ?? (above ? drawn.current : null);
  const from = frozen ? all.findIndex((line) => line.id === frozen[0]?.id) : -1;
  const merged = useMemo(() => (frozen && from >= 0 ? [...all.slice(0, from), ...frozen] : all), [all, frozen, from]);
  const rows = above && !shift ? drawn.current : merged;
  const letGo = useCallback(() => {
    if (!held.current) return;
    held.current = null;
    redraw();
  }, []);
  useLayoutEffect(() => {
    drawn.current = rows;
    held.current = rows === all ? null : frozen;
    if (above && !shift) {
      if (ripe.current === null) {
        ripe.current = false;
        // After the next frame is painted, its sizes have reached Virtua.
        requestAnimationFrame(() =>
          setTimeout(() => {
            if (ripe.current !== false) return;
            ripe.current = true;
            redraw();
          }),
        );
      }
      return;
    }
    ripe.current = null;
    if (!shift || rows === all) return;
    // A list too short to scroll gets no scroll end.
    scrolled.current = 0;
    clearTimeout(wait.current);
    wait.current = setTimeout(() => scrolled.current || letGo(), 200);
  });
  const hasFooter = footer !== undefined && footer !== null && footer !== false;
  const data = useMemo(() => [...rows, FOOTER], [rows]);
  const last = data.length - 1;
  const current = useRef(data);
  current.current = data;

  // The newest user message: pinned near the top when a new one arrives, until its reply fills the view.
  const newest = useMemo(() => {
    for (let at = all.length - 1; at >= 0; at--) {
      const line = all[at]!;
      if (line.type === "item" && line.item.kind === "message" && line.item.role === "user") return line.item;
    }
    return undefined;
  }, [all]);
  const space = useMemo(spaceStore, []);
  const pin = useRef<{ id: string; released: boolean } | null>(null);
  const fit = useCallback(() => {
    const handle = list.current;
    const viewport = box.current;
    const pinned = pin.current;
    // Older rows just arrived above: Virtua is still placing them (see the hold above), so wait for its scroll end.
    if (!handle || !viewport || !pinned || held.current) return;
    const lines = current.current;
    let at = lines.length - 1;
    while (at >= 0 && lines[at]!.id !== pinned.id) at--;
    const end = viewport.querySelector<HTMLElement>("[data-footer]");
    if (at < 0 || (pinned.released && !end)) {
      pin.current = null;
      space.set(0);
      return;
    }
    if (pinned.released) {
      // Where the rows end without the space: the footer's place plus its own content.
      const bottom = handle.getItemOffset(lines.length - 1) + end!.offsetHeight - space.get();
      // Given up: it only shrinks, to what is still on screen, so nothing moves.
      const next = Math.min(space.get(), Math.max(0, Math.ceil(handle.scrollOffset + handle.viewportSize - bottom)));
      space.set(next);
      if (next === 0) pin.current = null;
      return;
    }
    // The message's own top gap shows under the top fade.
    const row = viewport.querySelector<HTMLElement>(`[data-item="${CSS.escape(pinned.id)}"]`);
    const fade = viewport.querySelector<HTMLElement>('[data-slot="scroll-fade"]')?.offsetHeight ?? 0;
    const lift = Math.max(0, fade - (row ? parseFloat(getComputedStyle(row).paddingTop) : 0));
    // How far it is from its place, as drawn (a row above may have grown), else as Virtua places it.
    const drift = row ? row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - lift : handle.getItemOffset(at) - lift - handle.scrollOffset;
    const filled = () => {
      // The bottom works as before, and what grows below is away.
      pin.current = null;
      space.set(0);
      setAway(true);
    };
    // Our own move isn't the user scrolling up.
    const move = () => {
      scrolledTo.current = handle.scrollOffset + drift;
      handle.scrollBy(drift);
    };
    // What follows it runs past what is drawn: bring it up first (it came while the view was elsewhere); in place, it's filled.
    if (!end) return Math.abs(drift) > 1 ? move() : filled();
    // The message and what follows it, as drawn: Virtua's sizes for rows just added are only estimates.
    let below = end.offsetHeight - space.get();
    for (let line = at; line < lines.length - 1; line++) {
      const drawn = viewport.querySelector<HTMLElement>(`[data-item="${CSS.escape(lines[line]!.id)}"]`);
      below += drawn ? drawn.offsetHeight : handle.getItemSize(line);
    }
    const need = Math.max(0, Math.round(handle.viewportSize - lift - below));
    if (need === 0) return filled();
    space.set(need);
    if (Math.abs(drift) > 1) move();
  }, [space]);
  const seen = useRef(newest);
  const mine = useRef<string | null>(null);
  useLayoutEffect(() => {
    const before = seen.current;
    seen.current = newest;
    if (newest?.id === before?.id || before === undefined || newest === undefined) return;
    // Only this window's send pins a message; inputs from elsewhere keep the current follow state.
    if (mine.current !== newest.id && mine.current !== (newest.cid ?? newest.turnId)) return;
    pin.current = { id: newest.id, released: false };
    stuck.current = false;
    setAway(false);
    fit();
  }, [newest, fit]);

  // Rows too few to scroll give no scroll to ask for older ones on: ask once they are drawn and measured.
  const fill = () => {
    const handle = list.current;
    if (handle && handle.viewportSize > 0 && handle.scrollSize <= handle.viewportSize) source.older?.();
  };
  const toBottom = () => {
    stuck.current = true;
    setAway(false);
    list.current?.scrollToIndex(last, { align: "end" });
  };
  useImperativeHandle(ref, () => ({
    toBottom,
    toIndex: (index) => {
      stuck.current = false;
      // A jump away gives a pin's space up, as scrolling up does.
      if (pin.current) pin.current.released = true;
      list.current?.scrollToIndex(index, { align: "start" });
    },
    scrollBy: (offset) => {
      hand();
      list.current?.scrollBy(offset);
    },
    sent: (id) => {
      mine.current = id;
    },
  }), [last]);

  useLayoutEffect(() => {
    if (stuck.current) list.current?.scrollToIndex(last, { align: "end" });
    else fit();
    fill();
  }, [data, last, fit]);

  // A growing last row or footer is measured after the effect above, and the viewport can shrink (window, composer),
  // so follow the bottom again on any. Coming back to the bottom (away turns false) finds them remounted.
  const lastId = rows.at(-1)?.id;
  useEffect(() => {
    const viewport = box.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      if (stuck.current) list.current?.scrollToIndex(last, { align: "end" });
      else fit();
    });
    observer.observe(viewport);
    // Virtua's sized content: any row growing or shrinking.
    const content = viewport.firstElementChild?.firstElementChild;
    if (content) observer.observe(content);
    const row = lastId && viewport.querySelector(`[data-item="${CSS.escape(lastId)}"]`);
    if (row) observer.observe(row);
    const end = viewport.querySelector("[data-footer]");
    if (end) observer.observe(end);
    return () => observer.disconnect();
  }, [lastId, last, away, hasFooter, fit]);

  if (!session) return <p className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</p>;
  if (rows.length === 0) return <p className="flex h-full items-center justify-center text-sm text-muted-foreground">No messages yet</p>;
  return (
    <div
      ref={box}
      className="relative h-full"
      // Anything the user opens in a row (a code block's "Show more" too) stays where it is instead of following the bottom.
      onClickCapture={(event) => {
        if ((event.target as Element).closest("[aria-expanded]")) stuck.current = false;
      }}
      onWheel={(event) => event.deltaY < 0 && hand()}
      onKeyDown={hand}
      onPointerDown={() => {
        // A scrollbar drag lasts as long as the press, wherever it ends.
        byHand.current = Infinity;
        addEventListener("pointerup", () => (byHand.current = performance.now()), { once: true });
      }}
    >
      <VList
        ref={list}
        data={data}
        shift={shift}
        bufferSize={3200}
        className="h-full"
        onScrollEnd={letGo}
        onResize={fill}
        onScroll={(offset) => {
          scrolled.current++;
          const handle = list.current;
          if (!handle) return;
          const end = handle.scrollSize - offset - handle.viewportSize <= NEAR_END;
          const byUser = performance.now() - byHand.current < BY_HAND_MS;
          // Scrolled up past a pinned message: its space is given up.
          if (pin.current && offset < scrolledTo.current - 1 && byUser) pin.current.released = true;
          scrolledTo.current = offset;
          if (pin.current) fit();
          // The blank space under a pinned message isn't a bottom to follow.
          // Measurements and viewport resizes can move the offset before the end is followed again.
          if (end || byUser) stuck.current = end && space.get() === 0;
          // A pinned message's space is the latest, wherever our own moves pass on the way.
          setAway(!stuck.current && !end && pin.current?.released !== false);
          // Near the top, the source brings older rows, if it has any.
          if (offset < handle.viewportSize) source.older?.();
        }}
      >
        {(line: Line | typeof FOOTER) =>
          line.type === "footer" ? (
            <div key={FOOTER.id} data-footer className="mx-auto w-full max-w-reading px-6 pb-12">
              {hasFooter && <div className="pt-4 empty:hidden">{footer}</div>}
              <Spacer space={space} />
            </div>
          ) : (
            <LineRow key={line.id} {...line} dated={marks.dated.has(line.id)} latest={(line.type === "marks" ? line.item.id : line.id) === marks.latest} onToggle={toggle} />
          )
        }
      </VList>
      {/* Over the scroller, not in it: rows fade out under the top bar and at the bottom edge. */}
      <ScrollFade edge="top" />
      <ScrollFade edge="bottom" />
      {away && (
        <button
          type="button"
          aria-label="Jump to the latest"
          onClick={toBottom}
          className="group/jump absolute bottom-6 left-1/2 z-20 flex size-control-md items-center justify-center -translate-x-1/2 rounded-capsule bg-popover text-foreground shadow-overlay focus-visible:focus-ring"
        >
          <JumpSign running={turnList?.at(-1)?.status === "running"} />
        </button>
      )}
    </div>
  );
}
