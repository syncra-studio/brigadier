import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { Virtualizer, type CacheSnapshot, type VirtualizerHandle } from "virtua";

import type { Session } from "./item";
import { lineMaker, workKey, type Line } from "./lines";
import { MessageRail } from "./rail";
import { LineRow } from "./rows";
import { COLUMN } from "../components/composer/composer";
import { Find } from "./find";
import { Follow, OLDER, type Phase, type Space } from "./follow";
import { takePlace } from "./place";
import { store, useAgentLabel } from "../onboarding/api";
import { cx } from "../components/cx";
import { Skeleton } from "../components/skeleton";
import { JumpSign, ThinkingLine, datedMessages } from "../components/thread/message";
import { ScrollFade } from "../components/scroll-fade";

/**
 * Where the session comes from: null while it loads. After find went to an island far up (`after` set), `newer` asks
 * for the page under the rows held and `latest` for the newest rows again [D503].
 */
export type Source = { subscribe(listener: () => void): () => void; get(): Session | null; older?(): void; newer?(): void; latest?(): void };
/** `sent(id)`: this window sent the message under this row or command id, so it gets the space below and the glide. */
export type ThreadHandle = { toBottom(): void; toIndex(index: number): void; scrollBy(offset: number): void; sent(id: string): void };

/** Rows on their way, in the old app's shapes [D48]: a message, then a reply's lines. */
function Placeholder() {
  return (
    <div aria-hidden className="flex flex-col gap-2">
      <Skeleton className="ml-auto h-10 w-2/5 rounded-bubble" />
      <Skeleton className="mt-4 h-4 w-4/5" />
      <Skeleton className="h-4 w-3/5" />
    </div>
  );
}

/** A thread still on its way: blank for a moment, as an open is mostly quicker, then its placeholder. */
function Loading() {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), 200);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div role="status" className={`${COLUMN} pt-8`}>
      <span className="sr-only">Loading conversation</span>
      {late && <Placeholder />}
    </div>
  );
}

/** Under an island: the newer rows' place, asking for them whenever it's drawn, near the view. */
function Newer({ after, newer }: { after: number; newer?: () => void }) {
  useEffect(() => newer?.(), [after, newer]);
  return (
    <div role="status" className="pt-6">
      <span className="sr-only">Loading newer messages</span>
      <Placeholder />
    </div>
  );
}

/**
 * Each session's row heights as last drawn, by row id, while the app runs: opened again, the list knows them before it
 * draws, so the distance from the end it was left at lands on the same row [D457, D516]. By id, since the rows held
 * then can start elsewhere.
 */
const heights = new Map<string, { by: Map<string, number>; estimate?: number }>();
function cacheOf(id: string | undefined, data: readonly { id: string }[]): CacheSnapshot | undefined {
  const known = id === undefined ? undefined : heights.get(id);
  return known && [data.map((line) => known.by.get(line.id) ?? -1), known.estimate];
}

/** The space itself: an empty svg as tall as it, since our code sets no inline styles (D68). */
function Spacer({ space }: { space: Space }) {
  const height = space.use();
  return <svg data-spacer aria-hidden className="block" width="1" height={height} />;
}

/**
 * The session's rows, virtualised, with groups and finished turns' work closed until opened. How it scrolls is
 * defined in follow.ts: a message sent here glides up with space below that its reply grows into. `footer` goes
 * under the last row; `id` is the session's, so a source still on another session draws nothing and each session
 * opens where it was left.
 */
export function Thread({ id, source, footer, ref }: { id?: string; source: Source; footer?: ReactNode; ref?: Ref<ThreadHandle> }) {
  const got = useSyncExternalStore(source.subscribe, source.get);
  const session = id === undefined || got?.id === id ? got : null;
  const list = useRef<VirtualizerHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  // Opened groups and work folds: view state only, gone with the view.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const turnList = session?.turns;
  const workList = session?.work;
  const turns = useMemo(() => new Map(turnList?.map((turn) => [turn.id, turn])), [turnList]);
  const work = useMemo(() => new Map(workList?.map((each) => [each.turnId, each])), [workList]);
  const items = session?.items;
  // Under an island find went to, the newest rows load as the view gets there.
  const after = session?.after ?? null;
  const lines = useMemo(lineMaker, []);
  const dated = useMemo(() => datedMessages(items ?? []), [items]);
  const threadRows = useMemo(() => (items ? lines(items, turns, work, open) : []), [lines, items, turns, work, open]);
  const setup = session?.setup;
  const all = useMemo(() => {
    const rows = threadRows;
    // Under its input, first in that turn [D70]; until the input's row is in, the footer draws it.
    const at = setup?.after ? rows.findIndex((row) => row.id === setup.after) : -1;
    if (!setup || at < 0) return rows;
    // It's its turn's work's first item: folded away with it, and under its header opened [D77].
    const next = rows[at + 1];
    if (next?.type === "work" && next.open === false) return rows;
    const input = rows[at]!;
    const turn = input.type === "item" ? input.turn : undefined;
    const line: Line = { type: "setup", id: `${session.id}:setup`, gap: next?.type === "work" || turn ? "part" : "turn", setup };
    if (next?.type === "work") return [...rows.slice(0, at + 2), line, ...rows.slice(at + 2)];
    if (!turn) return [...rows.slice(0, at + 1), line, ...rows.slice(at + 1)];
    // The header is there before the turn's first step, under the id that step's header has, so nothing moves when it comes [D85].
    const head: Line = { type: "work", id: workKey(turn.id), gap: "turn", turn, work: undefined, open: null };
    return [...rows.slice(0, at + 1), head, line, ...rows.slice(at + 1)];
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
  const data = rows;
  const drawnData = useRef(data);

  const running = turnList?.at(-1)?.status === "running" && !turnList.at(-1)?.quiet;
  const agent = useAgentLabel(turnList?.at(-1)?.backend);
  // Said once a turn ran here, not for one that ended before the view opened.
  const ran = useRef(false);
  if (running) ran.current = true;
  // The latest turn's phase, from its last row: an assistant message under way is its answer, anything else its work.
  const tail = all.at(-1);
  // A finished setup under the newest message leaves it the turn's top, so Thinking shows under it.
  const top = tail?.type === "setup" && tail.setup.state === "done" ? all.at(all.at(-2)?.type === "work" ? -3 : -2) : tail;
  const phase: Phase = !running ? "idle" : tail?.type === "marks" || (tail?.type === "item" && tail.item.kind === "message" && tail.item.role === "assistant") ? "answer" : "work";
  // The newest user message: the latest turn's top.
  const newest = useMemo(() => {
    for (let at = all.length - 1; at >= 0; at--) {
      const line = all[at]!;
      if (line.type === "item" && line.item.kind === "message" && line.item.role === "user") return line.item;
    }
    return undefined;
  }, [all]);
  // The answer whose actions stay in view: the last turn's, gone once a newer message is sent [D82].
  const latest = useMemo(() => {
    for (let at = all.length - 1; at >= 0; at--) {
      const line = all[at]!;
      if (line.type === "marks") return line.id;
      if (line.type !== "item" || line.item.kind !== "message") continue;
      if (line.item.role === "user") return undefined;
      if (line.actions) return line.id;
    }
    return undefined;
  }, [all]);
  // Thinking at once while nothing of the running turn is live at its end: under its message on its way, under a reply
  // it carries on from (not one still being written [D147]), a turn the agent woke for with nothing of its own yet [D45],
  // or a question or approval just answered, until the agent's next event [D327].
  const last = turnList?.at(-1);
  const tailTurn = tail && (tail.type === "item" || tail.type === "group" || tail.type === "marks" ? tail.item.turnId : tail.type === "work" ? tail.turn.id : undefined);
  const answered = tail?.type === "item" && ((tail.item.kind === "question" && tail.item.answer !== null) || (tail.item.kind === "approval" && (tail.item.decision === "approved" || tail.item.decision === "denied")));
  const thinking =
    after === null &&
    running &&
    (answered ||
      (top?.type === "item" && top.item === newest) ||
      (tail !== undefined && tail.type !== "setup" && tailTurn !== last?.id) ||
      (tail?.type === "item" && tail.item.kind === "message" && tail.item.role === "assistant" && !tail.item.streaming));
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const space = useMemo(() => store(0), []);
  const follow = useMemo(() => {
    const made: Follow = new Follow(space, {
      older: () => sourceRef.current.older?.(),
      changed: () => setAway(made.shown()),
    });
    return made;
  }, [space]);
  const toggle = useCallback(
    (id: string) => {
      // What the user opens stays where it is instead of the list following the bottom.
      follow.hold();
      setOpen((was) => {
        const next = new Set(was);
        if (!next.delete(id)) next.add(id);
        return next;
      });
    },
    [follow],
  );
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
      sourceRef.current.latest?.();
      follow.pending = cid;
      // Once the bubble is drawn in the footer.
      requestAnimationFrame(() => follow.place());
    },
  }), [follow, running]);

  // Before it is opened, so a running turn opens following its work or its answer.
  useLayoutEffect(() => follow.setPhase(phase), [follow, phase]);
  // A footer shows before the session does: a start from Home has only its message there at first.
  const listed = rows.length > 0 || hasFooter;
  // Read by Virtua once, as the list mounts: made as it appears, from the rows it mounts with (so not on `data`).
  const cache = useMemo(() => (listed ? cacheOf(id, data) : undefined), [listed, id]);
  useLayoutEffect(() => {
    const el = listed ? (box.current?.firstElementChild as HTMLElement | null) : null;
    if (!el) return;
    follow.el = el;
    follow.open(id, running);
    const first = id === undefined ? undefined : takePlace(id);
    if (first !== undefined) {
      follow.pending = first;
      requestAnimationFrame(() => follow.place(false));
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
    // Virtua's sized content (any row growing or shrinking), and the footer under it.
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    const footed = el.querySelector("[data-footer]");
    if (footed) observer.observe(footed);
    return () => {
      const [sizes, estimate] = list.current?.cache ?? [[]];
      const by = new Map<string, number>();
      drawnData.current.forEach((line, at) => {
        const size = sizes[at] ?? -1;
        if (size >= 0) by.set(line.id, size);
      });
      if (id !== undefined && by.size) heights.set(id, { by, estimate });
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
  // Under an island the end isn't the newest: it never follows there, so rows coming under it stay below.
  useLayoutEffect(() => {
    if (after !== null) follow.hold();
  }, [follow, data, after]);
  // The jump button under an island: once the newest rows are back, to their end.
  const toLatest = useRef(false);
  useLayoutEffect(() => {
    if (after !== null || !toLatest.current) return;
    toLatest.current = false;
    follow.jump(running);
  });
  // New rows: placed, followed or taken from the space before the paint.
  useLayoutEffect(() => {
    if (phase === "idle" && after === null && drawnData.current !== data) {
      const had = new Set(drawnData.current.map((line) => line.id));
      const last = data.findLastIndex((line) => had.has(line.id));
      const came = last < 0 ? undefined : data[last + 1];
      if (came) follow.arrive(came.id);
    }
    drawnData.current = data;
    follow.resized();
    fill();
  }, [follow, data]);

  // Words here would flash on every open; the column stays empty for the moment it takes.
  if (!listed && !session) return <Loading />;
  if (!listed) return <p className="flex h-full items-center justify-center text-sm text-muted-foreground">No messages yet</p>;
  const jumps = away || after !== null;
  return (
    // The old app's thread type: 14px, smoothed.
    <div ref={box} className="relative h-full text-sm antialiased">
      {/* Its edges fade out, it keeps its scrolling to itself, and it snaps to the end while following there.
          The footer and the space are in its own flow under Virtua's rows, so a change to the space counts at once and
          nothing the browser clamps reaches the screen [D45]. */}
      <div
        className="scroll-gutter-both thread-edge-mask end-snap block size-full overflow-y-auto overscroll-y-contain contain-strict"
        onScroll={() => {
          scrolled.current++;
          follow.scroll();
        }}
      >
        <Virtualizer
          ref={list}
          data={data}
          cache={cache}
          shift={shift}
          bufferSize={3200}
          // A row not yet measured is guessed at the shortest a row is drawn (a one-line row with its gap), never at
          // Virtua's average: a guess too tall shrinks once measured and pulls the screen with it [D45].
          itemSize={54}
          onScrollEnd={letGo}
        >
          {/* The newest row a message: its time and actions in view, as its bubble's on its way, which hide their kept room otherwise. */}
          {(line: Line) => <LineRow key={line.id} {...line} dated={dated.has(line.id)} older={line.id !== latest && !(after === null && line.id === tail?.id && line.type === "item" && line.item.kind === "message" && line.item.role === "user")} onToggle={toggle} />}
        </Virtualizer>
        <div data-footer>
          <div className={`${COLUMN} pb-8`}>
            {after !== null && <Newer after={after} newer={source.newer} />}
            {thinking && <div className="pt-3"><ThinkingLine /></div>}
            {/* With no rows yet, the footer is the first row, with a first row's gap (rows.tsx). */}
            {hasFooter && after === null && <div data-rows={rows.length > 0 || undefined} data-first={rows.length === 0 || undefined} className={`${rows.length > 0 ? "pt-3" : "pt-8"} empty:hidden`}>{footer}</div>}
            <Spacer space={space} />
          </div>
          <div data-end aria-hidden className="end-snap-target" />
        </div>
      </div>
      {/* A screen reader hears a turn start and end, as a polite status. */}
      <p role="status" className="sr-only">{running ? `${agent} is working` : ran.current ? `${agent} finished` : ""}</p>
      <MessageRail rows={data} items={items ?? []} list={list} scroller={scroller} box={box} away={leaveEnd} />
      <Find id={id} source={source} scroller={scroller} rows={data} items={items ?? []} onOpen={openAll} toIndex={toIndex} away={leaveEnd} />
      {/* Over the composer, the old app's: solid up to the jump button's top while it shows, then the text fades out. */}
      <ScrollFade raised={jumps} />
      {/* Kept in place and faded in and out (the old app's look). Centred on the reading column, which the pinned card
          moves aside, never on the pane. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 mx-auto flex w-full max-w-reading justify-center">
        <button
          type="button"
          aria-label="Jump to the latest"
          aria-hidden={!jumps || undefined}
          tabIndex={jumps ? undefined : -1}
          onClick={jumps ? () => (after === null ? follow.jump(running) : ((toLatest.current = true), source.latest?.())) : undefined}
          className={cx(
            "group/jump flex size-control-md cursor-pointer items-center justify-center rounded-capsule border border-border bg-background bg-clip-padding text-foreground transition-opacity focus-visible:focus-ring motion-reduce:transition-none",
            jumps ? "pointer-events-auto" : "opacity-0",
          )}
        >
          <JumpSign running={running} />
        </button>
      </div>
    </div>
  );
}
