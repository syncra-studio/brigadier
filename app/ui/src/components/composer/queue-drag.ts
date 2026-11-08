import { type KeyboardEvent, type PointerEvent, type RefObject, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

type Row = { id: string; element: HTMLElement; start: number; size: number };
type Drag = { id: string; pointer: number; origin: number; at: number; to: number; rows: Row[]; scroll: number };

/** The list with one item moved, found by id even if an update moved its slot meanwhile. */
function moved<T extends { id: string }>(items: readonly T[], id: string, to: number): readonly T[] {
  const item = items.find((each) => each.id === id);
  if (!item) return items;
  const rest = items.filter((each) => each.id !== id);
  rest.splice(to, 0, item);
  return rest;
}

/** Back to rest, all at once, so nothing slides home. */
function restore(list: HTMLElement | null, drag: Drag) {
  list?.removeAttribute("data-reordering");
  for (const row of drag.rows) {
    row.element.removeAttribute("data-shift");
    row.element.removeAttribute("data-grabbed");
  }
}

/**
 * Drag-to-reorder for the queue (the old app's): the grabbed row follows the pointer while the others slide
 * into their new slots (the `queue-shift` utility reads `data-shift`), and nothing moves in the DOM until
 * release. The new order shows at once and holds until `items` changes; ↑/↓ on the grip move one step, Esc
 * cancels a drag.
 */
export function useQueueDrag<T extends { id: string }>(items: readonly T[], onMove: (id: string, to: number) => void) {
  const listRef = useRef<HTMLOListElement>(null);
  const active = useRef<Drag | null>(null);
  const [pending, setPending] = useState<{ source: readonly T[]; id: string; to: number } | null>(null);
  const shown = pending?.source === items ? moved(items, pending.id, pending.to) : items;
  const latest = useRef({ items, shown, onMove });
  useLayoutEffect(() => {
    latest.current = { items, shown, onMove };
  });

  const measure = (drag: Drag) => {
    const list = listRef.current;
    if (!list) return;
    restore(list, drag);
    drag.scroll = list.scrollTop;
    drag.rows = [...list.querySelectorAll<HTMLElement>(":scope > [data-slot=queue-item]")].flatMap((element, index) => {
      const item = latest.current.shown[index];
      if (!item) return [];
      const rect = element.getBoundingClientRect();
      return [{ id: item.id, element, start: rect.top, size: rect.height }];
    });
  };
  const paint = (drag: Drag) => {
    const list = listRef.current;
    const grabbed = drag.rows.find((row) => row.id === drag.id);
    if (!list || !grabbed) return;
    const delta = drag.at - drag.origin + list.scrollTop - drag.scroll;
    const center = grabbed.start + grabbed.size / 2 + delta;
    const rest = drag.rows.filter((row) => row.id !== drag.id);
    drag.to = rest.filter((row) => center > row.start + row.size / 2).length;
    const order = [...rest];
    order.splice(drag.to, 0, grabbed);
    const gap = drag.rows.length > 1 ? drag.rows[1]!.start - drag.rows[0]!.start - drag.rows[0]!.size : 0;
    let slot = drag.rows[0]?.start ?? 0;
    list.setAttribute("data-reordering", "");
    grabbed.element.setAttribute("data-grabbed", "");
    for (const row of order) {
      row.element.setAttribute("data-shift", String(row === grabbed ? delta : slot - row.start));
      slot += row.size + gap;
    }
  };
  const finish = (commit: boolean) => {
    const drag = active.current;
    if (!drag) return;
    active.current = null;
    restore(listRef.current, drag);
    const { items, onMove } = latest.current;
    const from = items.findIndex((item) => item.id === drag.id);
    if (commit && from >= 0 && from !== drag.to) {
      setPending({ source: items, id: drag.id, to: drag.to });
      onMove(drag.id, drag.to);
    }
  };

  // Rows can come, go or move during a drag: measure them again by id, keeping the grabbed one under the pointer.
  const itemsChanged = useEffectEvent((now: readonly T[]) => {
    const drag = active.current;
    if (!drag) return;
    if (!now.some((item) => item.id === drag.id)) return finish(false);
    const grabbed = drag.rows.find((row) => row.id === drag.id);
    const visual = grabbed ? grabbed.start + drag.at - drag.origin : null;
    measure(drag);
    const next = drag.rows.find((row) => row.id === drag.id);
    if (visual !== null && next) drag.origin = drag.at - (visual - next.start);
    paint(drag);
  });
  useLayoutEffect(() => itemsChanged(items), [items]);
  useLayoutEffect(
    () => () => {
      if (active.current) restore(listRef.current, active.current);
    },
    [],
  );

  const grip = (id: string, index: number) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || active.current) return;
      event.preventDefault();
      // preventDefault keeps focus where it was: give it to the grip, so Esc cancels here, not as Stop.
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      const drag: Drag = { id, pointer: event.pointerId, origin: event.clientY, at: event.clientY, to: index, rows: [], scroll: 0 };
      active.current = drag;
      measure(drag);
      paint(drag);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const drag = active.current;
      if (!drag || drag.pointer !== event.pointerId) return;
      drag.at = event.clientY;
      paint(drag);
    },
    onPointerUp: () => finish(true),
    onPointerCancel: () => finish(false),
    onLostPointerCapture: () => finish(false),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape" && active.current) {
        event.preventDefault();
        return finish(false);
      }
      const to = index + (event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0);
      if (to === index || to < 0 || to >= shown.length) return;
      event.preventDefault();
      setPending({ source: items, id, to });
      onMove(id, to);
    },
  });
  return { listRef, shown, grip };
}
