import { useCallback, useImperativeHandle, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { VList, type VListHandle } from "virtua";

import type { Session } from "./item";
import { lineMaker, type Line } from "./lines";
import { LineRow } from "./rows";
import { Find } from "./find";
import { Follow, OLDER, spaceStore, takePlace, type Phase, type Space } from "./follow";
import { cx } from "../components/cx";
import { JumpSign, datedMessages } from "../components/thread/message";

/** Where the session comes from: null while it loads. */
export type Source = { subscribe(listener: () => void): () => void; get(): Session | null; older?(): void };
/** `sent(id)`: this window sent the message under this row or command id, so it gets the space below and the glide. */
export type ThreadHandle = { toBottom(): void; toIndex(index: number): void; scrollBy(offset: number): void; sent(id: string): void };

/** After the last row: the working line and the bubbles on their way, then the space, then room at the end. */
const FOOTER = { type: "footer", id: "footer" } as const;

/** The space itself: an empty svg as tall as it, since our code sets no inline styles (D68). */
function Spacer({ space }: { space: Space }) {
  const height = useSyncExternalStore(space.subscribe, space.get);
  return <svg data-spacer aria-hidden className="block" width="1" height={height} />;
}

/**
 * The session's rows, virtualised, with groups and finished turns' work closed until opened. How it scrolls is
 * follow.ts's: a message sent here glides up with space below that its reply grows into. `footer` goes
 * under the last row; `id` is the session's, so a source still on another session draws nothing and each session
 * opens where it was left.
 */
export function Thread({ id, source, footer, ref }: { id?: string; source: Source; footer?: ReactNode; ref?: Ref<ThreadHandle> }) {
  const got = useSyncExternalStore(source.subscribe, source.get);
  const session = id === undefined || got?.id === id ? got : null;
  const list = useRef<VListHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  // Opened groups and work folds: view state only, gone with the view.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
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
  const dated = useMemo(() => datedMessages(items ?? []), [items]);
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

  const running = turnList?.at(-1)?.status === "running";
  // The latest turn's phase, from its last row: an assistant message under way is its answer, anything else its work.
  const tail = all.at(-1);
  const phase: Phase = !running ? "idle" : tail?.type === "marks" || (tail?.type === "item" && tail.item.kind === "message" && tail.item.role === "assistant") ? "answer" : "work";
  // The newest user message: the latest turn's top, which its growth is measured from.
  const newest = useMemo(() => {
    for (let at = all.length - 1; at >= 0; at--) {
      const line = all[at]!;
      if (line.type === "item" && line.item.kind === "message" && line.item.role === "user") return line.item;
    }
    return undefined;
  }, [all]);
  const newestRef = useRef(newest);
  newestRef.current = newest;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const space = useMemo(spaceStore, []);
  const follow = useMemo(() => {
    const made: Follow = new Follow(space, {
      older: () => sourceRef.current.older?.(),
      changed: () => setAway(made.shown()),
      anchor: () => {
        const user = newestRef.current;
        // A message sent here and not in the rows yet has its bubble in the footer: the footer is the turn's top.
        if (made.pending || !user) return made.el?.querySelector("[data-footer]") ?? null;
        return made.el?.querySelector(`[data-item="${CSS.escape(user.id)}"]`) ?? null;
      },
    });
    return made;
  }, [space]);
  if (follow.pending && newest && [newest.id, newest.cid, newest.turnId].includes(follow.pending)) follow.pending = null;

  // Find in the conversation: it reads the scroller, opens folds and scrolls only through these.
  const scroller = useCallback(() => follow.el, [follow]);
  const openAll = useCallback((ids: readonly string[]) => setOpen((was) => new Set([...was, ...ids])), []);
  const toIndex = useCallback((index: number) => (follow.away(), list.current?.scrollToIndex(index, { align: "start" })), [follow]);
  const leaveEnd = useCallback(() => follow.away(), [follow]);

  // Rows too few to scroll give no scroll to ask for older ones on: ask until there is more than a little to scroll.
  const fill = () => {
    const el = follow.el;
    if (el && el.clientHeight > 0 && el.scrollHeight - el.clientHeight <= OLDER) source.older?.();
  };
  useImperativeHandle(ref, () => ({
    toBottom: () => follow.jump(running),
    toIndex: (index) => {
      follow.away();
      list.current?.scrollToIndex(index, { align: "start" });
    },
    scrollBy: (offset) => {
      follow.intend(offset < 0 ? "away" : "toward", true);
      list.current?.scrollBy(offset);
    },
    sent: (cid) => {
      follow.pending = cid;
      // Once the bubble is drawn in the footer.
      requestAnimationFrame(() => follow.place());
    },
  }), [follow, running]);

  // Before it is opened, so a running turn opens following its work or its answer.
  useLayoutEffect(() => follow.setPhase(phase), [follow, phase]);
  // A footer shows before the session does: a start from Home has only its message there at first.
  const listed = rows.length > 0 || hasFooter;
  useLayoutEffect(() => {
    const el = listed ? (box.current?.firstElementChild as HTMLElement | null) : null;
    if (!el) return;
    follow.el = el;
    follow.open(id, running);
    const first = id === undefined ? undefined : takePlace(id);
    if (first !== undefined) {
      follow.pending = first;
      requestAnimationFrame(() => follow.place());
    }
    const on: [string, EventListener][] = [
      ["wheel", follow.wheel as EventListener],
      ["keydown", follow.key as EventListener],
      ["pointerdown", follow.press as EventListener],
      ["touchstart", follow.touchStart as EventListener],
      ["touchmove", follow.touchMove as EventListener],
      ["touchend", follow.touchEnd],
    ];
    for (const [type, listener] of on) el.addEventListener(type, listener, { passive: true });
    // A wheel, touch, press or key stops the glide before anything else hears it.
    const stops = ["wheel", "touchstart", "pointerdown", "keydown"];
    for (const type of stops) el.addEventListener(type, follow.stopPlacing, { capture: true, passive: true });
    // A scrollbar drag ends wherever the pointer is let go.
    addEventListener("pointerup", follow.release);
    addEventListener("pointercancel", follow.release);
    const observer = new ResizeObserver(() => {
      follow.resized();
      fill();
    });
    observer.observe(el);
    // Virtua's sized content: any row growing or shrinking.
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => {
      follow.leave(id);
      for (const [type, listener] of on) el.removeEventListener(type, listener);
      for (const type of stops) el.removeEventListener(type, follow.stopPlacing, { capture: true });
      removeEventListener("pointerup", follow.release);
      removeEventListener("pointercancel", follow.release);
      observer.disconnect();
      follow.el = null;
    };
    // Opened once per list: `running` is read as the list appears.
  }, [follow, listed, id]);
  // New rows: placed, followed or taken from the space before the paint.
  useLayoutEffect(() => {
    follow.resized();
    fill();
  }, [follow, data]);

  // Words here would flash on every open; the column stays empty for the moment it takes.
  if (!listed && !session) return <span role="status" className="sr-only">Loading conversation</span>;
  if (!listed) return <p className="flex h-full items-center justify-center text-sm text-muted-foreground">No messages yet</p>;
  return (
    // The old app's thread type: 14px, smoothed.
    <div ref={box} className="relative h-full text-sm antialiased">
      <VList
        ref={list}
        data={data}
        shift={shift}
        bufferSize={3200}
        // Its edges fade out, it keeps its scrolling to itself, and it snaps to the end while following there.
        className="scroll-gutter-both thread-edge-mask end-snap h-full overscroll-y-contain"
        onScrollEnd={letGo}
        onScroll={() => {
          scrolled.current++;
          follow.scroll();
        }}
      >
        {(line: Line | typeof FOOTER) =>
          line.type === "footer" ? (
            <div key={FOOTER.id} data-footer>
              <div className="mx-auto w-full max-w-reading px-6 pb-8">
                {/* With no rows yet, the footer is the first row: its gap clears find's bar, as a first row's does (rows.tsx). */}
                {hasFooter && <div className={`${rows.length > 0 ? "pt-4" : "pt-thread-find-top"} empty:hidden`}>{footer}</div>}
                <Spacer space={space} />
              </div>
              <div data-end aria-hidden className="end-snap-target" />
            </div>
          ) : (
            <LineRow key={line.id} {...line} dated={dated.has(line.id)} onToggle={toggle} />
          )
        }
      </VList>
      <Find source={source} scroller={scroller} rows={data} items={items ?? []} onOpen={openAll} toIndex={toIndex} away={leaveEnd} />
      {/* Kept in place and faded in and out (the old app's look). */}
      <button
        type="button"
        aria-label="Jump to the latest"
        aria-hidden={!away || undefined}
        tabIndex={away ? undefined : -1}
        onClick={away ? () => follow.jump(running) : undefined}
        className={cx(
          "group/jump absolute bottom-6 left-1/2 z-20 flex size-control-md -translate-x-1/2 cursor-pointer items-center justify-center rounded-capsule border border-border bg-background bg-clip-padding text-foreground transition-opacity focus-visible:focus-ring motion-reduce:transition-none",
          !away && "pointer-events-none opacity-0",
        )}
      >
        <JumpSign running={running} />
      </button>
    </div>
  );
}
