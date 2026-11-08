import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { VList, type VListHandle } from "virtua";

import type { Session } from "./item";
import { lineMaker, type Line } from "./lines";
import { LineRow } from "./rows";
import { ScrollFade } from "../components/scroll-fade";

/** Where the session comes from: null while it loads. */
export type Source = { subscribe(listener: () => void): () => void; get(): Session | null };
export type ThreadHandle = { toBottom(): void; toIndex(index: number): void; scrollBy(offset: number): void };

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
  const all = useMemo(() => (items ? lines(items, turns, work, open) : []), [lines, items, turns, work, open]);
  // Older rows arriving above: Virtua keeps what is on screen in place when told the list grew at its start, but until
  // its next scroll end it holds every later resize to the list's end, so a row added or growing below would move the
  // screen. So once rows arrive above, the rows from the old first on stay as drawn until Virtua's scroll end.
  const drawn = useRef<readonly Line[]>([]);
  const held = useRef<readonly Line[] | null>(null);
  const scrolled = useRef(0);
  const wait = useRef<ReturnType<typeof setTimeout>>(undefined);
  const before = drawn.current[0]?.id;
  const shift = before !== undefined && all[0]?.id !== before && all.some((line) => line.id === before);
  const frozen = held.current ?? (shift ? drawn.current : null);
  const from = frozen ? all.findIndex((line) => line.id === frozen[0]?.id) : -1;
  const rows = useMemo(() => (frozen && from >= 0 ? [...all.slice(0, from), ...frozen] : all), [all, frozen, from]);
  const letGo = useCallback(() => {
    if (!held.current) return;
    held.current = null;
    redraw();
  }, []);
  useLayoutEffect(() => {
    drawn.current = rows;
    held.current = rows === all ? null : frozen;
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
      if (line.type === "item" && line.item.kind === "message" && line.item.role === "user") return line.id;
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
    if (at < 0 || !end) {
      if (pinned.released || at < 0) (pin.current = null), space.set(0);
      return;
    }
    const base = end.offsetHeight - space.get();
    if (pinned.released) {
      // Where the rows end without the space: the footer's place plus its own content.
      const bottom = handle.getItemOffset(lines.length - 1) + base;
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
    // The message and what follows it, as drawn: Virtua's sizes for rows just added are only estimates.
    let below = base;
    for (let line = at; line < lines.length - 1; line++) {
      const drawn = viewport.querySelector<HTMLElement>(`[data-item="${CSS.escape(lines[line]!.id)}"]`);
      below += drawn ? drawn.offsetHeight : handle.getItemSize(line);
    }
    const need = Math.max(0, Math.round(handle.viewportSize - lift - below));
    const top = handle.getItemOffset(at) - lift;
    space.set(need);
    if (need === 0) {
      // Filled: the bottom works as before, and what grows below is away.
      pin.current = null;
      setAway(true);
    } else {
      // Keep it there from where it is drawn (a row above may have grown); our own move isn't the user scrolling up.
      const drift = row ? row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - lift : top - handle.scrollOffset;
      if (Math.abs(drift) > 1) {
        scrolledTo.current = handle.scrollOffset + drift;
        handle.scrollBy(drift);
      }
    }
  }, [space]);
  const seen = useRef(newest);
  useLayoutEffect(() => {
    const before = seen.current;
    seen.current = newest;
    if (newest === before || before === undefined || newest === undefined) return;
    pin.current = { id: newest, released: false };
    stuck.current = false;
    setAway(false);
    fit();
  }, [newest, fit]);

  const toBottom = () => {
    stuck.current = true;
    setAway(false);
    list.current?.scrollToIndex(last, { align: "end" });
  };
  useImperativeHandle(ref, () => ({
    toBottom,
    toIndex: (index) => {
      stuck.current = false;
      list.current?.scrollToIndex(index, { align: "start" });
    },
    scrollBy: (offset) => {
      hand();
      list.current?.scrollBy(offset);
    },
  }), [last]);

  useLayoutEffect(() => {
    if (stuck.current) list.current?.scrollToIndex(last, { align: "end" });
    else fit();
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
        bufferSize={800}
        className="h-full"
        onScrollEnd={letGo}
        onScroll={(offset) => {
          scrolled.current++;
          const handle = list.current;
          if (!handle) return;
          const end = handle.scrollSize - offset - handle.viewportSize <= NEAR_END;
          // Scrolled up past a pinned message: its space is given up.
          if (pin.current && offset < scrolledTo.current - 1 && performance.now() - byHand.current < BY_HAND_MS) pin.current.released = true;
          scrolledTo.current = offset;
          if (pin.current) fit();
          // The blank space under a pinned message isn't a bottom to follow.
          stuck.current = end && space.get() === 0;
          setAway(!end);
        }}
      >
        {(line: Line | typeof FOOTER) =>
          line.type === "footer" ? (
            <div key={FOOTER.id} data-footer className="mx-auto w-full max-w-reading px-6 pb-12">
              {hasFooter && <div className="pt-4 empty:hidden">{footer}</div>}
              <Spacer space={space} />
            </div>
          ) : (
            <LineRow key={line.id} {...line} onToggle={toggle} />
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
          className="absolute bottom-6 left-1/2 z-20 size-control-md -translate-x-1/2 rounded-capsule bg-popover text-foreground shadow-overlay"
        >
          ↓
        </button>
      )}
    </div>
  );
}
