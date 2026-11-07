import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { VList, type VListHandle } from "virtua";

import type { Session } from "./item";
import { lineMaker, type Line } from "./lines";
import { LineRow } from "./rows";

/** Where the session comes from: null while it loads. */
export type Source = { subscribe(listener: () => void): () => void; get(): Session | null };
export type ThreadHandle = { toBottom(): void; toIndex(index: number): void; scrollBy(offset: number): void };

/** How close to the end, in px, still counts as at the bottom. */
const NEAR_END = 2;
/** The footer's place in the list, after the last row. */
const FOOTER = { type: "footer", id: "footer" } as const;

/**
 * The session's rows, virtualised, with groups and finished turns' work closed until opened; it follows the bottom
 * while the user is there. `footer` goes under the last row (the working line).
 */
export function Thread({ source, footer, ref }: { source: Source; footer?: ReactNode; ref?: Ref<ThreadHandle> }) {
  const session = useSyncExternalStore(source.subscribe, source.get);
  const list = useRef<VListHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
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
  const data = useMemo(() => (hasFooter ? [...rows, FOOTER] : rows), [rows, hasFooter]);
  const last = data.length - 1;

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
    scrollBy: (offset) => list.current?.scrollBy(offset),
  }), [last]);

  useLayoutEffect(() => {
    if (stuck.current) list.current?.scrollToIndex(last, { align: "end" });
  }, [data, last]);

  // A growing last row or footer is measured after the effect above, and the viewport can shrink (window, composer),
  // so follow the bottom again on any. Coming back to the bottom (away turns false) finds them remounted.
  const lastId = rows.at(-1)?.id;
  useEffect(() => {
    const viewport = box.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      if (stuck.current) list.current?.scrollToIndex(last, { align: "end" });
    });
    observer.observe(viewport);
    const row = lastId && viewport.querySelector(`[data-item="${CSS.escape(lastId)}"]`);
    if (row) observer.observe(row);
    const end = viewport.querySelector("[data-footer]");
    if (end) observer.observe(end);
    return () => observer.disconnect();
  }, [lastId, last, away, hasFooter]);

  if (!session) return <p className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</p>;
  if (rows.length === 0) return <p className="flex h-full items-center justify-center text-sm text-muted-foreground">No messages yet</p>;
  return (
    <div ref={box} className="relative h-full">
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
          stuck.current = handle.scrollSize - offset - handle.viewportSize <= NEAR_END;
          setAway(!stuck.current);
        }}
      >
        {(line: Line | typeof FOOTER) =>
          line.type === "footer" ? (
            <div key={FOOTER.id} data-footer className="mx-auto w-full max-w-reading px-6 pt-4">
              {footer}
            </div>
          ) : (
            <LineRow key={line.id} {...line} onToggle={toggle} />
          )
        }
      </VList>
      {away && (
        <button
          type="button"
          aria-label="Jump to the latest"
          onClick={toBottom}
          className="absolute bottom-4 left-1/2 size-control-md -translate-x-1/2 rounded-capsule bg-popover text-foreground shadow-overlay"
        >
          ↓
        </button>
      )}
    </div>
  );
}
