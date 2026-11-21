import { type PointerEvent as ReactPointerEvent, useRef } from "react";

import { cx } from "./cx";

/** A theme length (rem) in CSS pixels. */
export const px = (name: string) => {
  const root = getComputedStyle(document.documentElement);
  return Number.parseFloat(root.getPropertyValue(name)) * Number.parseFloat(root.fontSize);
};

/**
 * The grab area straddling a column's edge (the old SidebarResizeHandle): Files' start edge, or with `end` the left
 * sidebar's: 8 wide just past its edge under the titlebar row, the line on the edge itself [D21 D188]. The
 * width goes on `holder`'s data-width while dragged. Dragged under `hideBelow` it closes; with `onOpen` the drag goes on,
 * and coming back over it opens again.
 */
export function ResizeHandle({ label, resizing, setResizing, onWidth, onClose, onOpen, hideBelow, end = false, min = "--spacing-sidebar-min", max = "--spacing-sidebar-max", holder = (handle) => handle.parentElement }: {
  label: string;
  end?: boolean;
  /** The width it closes under; half its least by default. */
  hideBelow?: number;
  onOpen?: () => void;
  /** The width's range, theme lengths. */
  min?: string;
  max?: string;
  holder?: (handle: HTMLElement) => Element | null;
  resizing: boolean;
  setResizing: (resizing: boolean) => void;
  onWidth: (width: number) => void;
  onClose: () => void;
}) {
  const start = useRef<{ x: number; width: number; closed: boolean } | null>(null);
  const latest = useRef<number | null>(null);

  const stop = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setResizing(false);
    if (latest.current !== null) onWidth(latest.current);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      data-resizing={resizing || undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const panel = event.currentTarget.previousElementSibling;
        if (!panel) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, width: panel.getBoundingClientRect().width, closed: false };
        latest.current = null;
        setResizing(true);
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        // A release that never reached the handle still ends the drag, so the width is kept app-wide [D1033].
        if (!(event.buttons & 1)) return stop(event);
        const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
        const wanted = start.current.width + (event.clientX - start.current.x) * (rtl !== end ? 1 : -1);
        const least = px(min);
        if (wanted < (hideBelow ?? least / 2)) {
          if (start.current.closed) return;
          // Closed by the drag, it keeps the width it had when the drag began, for when it opens again.
          latest.current = Math.round(start.current.width);
          holder(event.currentTarget)?.setAttribute("data-width", String(latest.current));
          start.current.closed = true;
          if (!onOpen) stop(event);
          onClose();
          return;
        }
        if (start.current.closed) {
          start.current.closed = false;
          onOpen?.();
        }
        latest.current = Math.round(Math.min(Math.max(wanted, least), px(max)));
        // Follows the pointer without a render; the width is kept when the drag ends.
        holder(event.currentTarget)?.setAttribute("data-width", String(latest.current));
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      className={cx(
        "group/resize absolute bottom-0 z-10 flex cursor-col-resize",
        end ? "end-0 top-tab-bar w-2 translate-x-full rtl:-translate-x-full" : "start-0 top-0 w-resize-handle -translate-x-1/2 justify-center rtl:translate-x-1/2",
      )}
    >
      <span className={cx("w-px bg-resize-line opacity-0 group-hover/resize:opacity-100 group-data-resizing/resize:opacity-100", end && "-translate-x-1/2 rtl:translate-x-1/2")} />
    </div>
  );
}
