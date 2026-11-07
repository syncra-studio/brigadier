import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type Ref } from "react";
import { VList, type VListHandle } from "virtua";

import type { Item, Session } from "./item";
import { Row } from "./rows";

/** Where the session comes from: null while it loads. */
export type Source = { subscribe(listener: () => void): () => void; get(): Session | null };
export type ThreadHandle = { toBottom(): void; toIndex(index: number): void; scrollBy(offset: number): void };

/** How close to the end, in px, still counts as at the bottom. */
const NEAR_END = 2;

/** The session's rows, virtualised; it follows the bottom while the user is there. */
export function Thread({ source, ref }: { source: Source; ref?: Ref<ThreadHandle> }) {
  const session = useSyncExternalStore(source.subscribe, source.get);
  const items = session?.items ?? [];
  const list = useRef<VListHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [away, setAway] = useState(false);
  const last = items.length - 1;
  // Older items arriving above: Virtua keeps what is on screen in place only when told the list grew at its start.
  // shortcut: Virtua shifts by the whole length change, so items added above and below in one update land wrong; the
  // source must send history and new items as separate updates, or this needs Virtua-independent anchoring.
  const first = useRef<string | undefined>(undefined);
  const shift = first.current !== undefined && items[0]?.id !== first.current && items.some((item) => item.id === first.current);
  useLayoutEffect(() => {
    first.current = items[0]?.id;
  });

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
  }, [items, last]);

  // A growing last row is measured after the effect above, and the viewport can shrink (window, composer), so
  // follow the bottom again on either. Coming back to the bottom (away turns false) finds the row remounted.
  const lastId = items[last]?.id;
  useEffect(() => {
    const viewport = box.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      if (stuck.current) list.current?.scrollToIndex(last, { align: "end" });
    });
    observer.observe(viewport);
    const row = lastId && viewport.querySelector(`[data-item="${CSS.escape(lastId)}"]`);
    if (row) observer.observe(row);
    return () => observer.disconnect();
  }, [lastId, last, away]);

  if (!session) return <p className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</p>;
  if (items.length === 0) return <p className="flex h-full items-center justify-center text-sm text-muted-foreground">No messages yet</p>;
  return (
    <div ref={box} className="relative h-full">
      <VList
        ref={list}
        data={items}
        shift={shift}
        bufferSize={800}
        className="h-full"
        onScroll={(offset) => {
          const handle = list.current;
          if (!handle) return;
          stuck.current = handle.scrollSize - offset - handle.viewportSize <= NEAR_END;
          setAway(!stuck.current);
        }}
      >
        {(item: Item, index: number) => <Row key={item.id} item={item} first={index > 0 && item.turnId !== items[index - 1]!.turnId} />}
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
