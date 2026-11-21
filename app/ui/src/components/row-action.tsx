import type { ComponentProps, ReactNode } from "react";

import { cx } from "./cx";

/**
 * An icon button on a row's end (21×20), shown while the row (marked `group/row`) is hovered or keyboard-focused. Name it with
 * `aria-label`. `header`: a section header's larger one; `round`, that one as a circle inside a capsule field.
 */
export function RowAction({ header = false, round = false, className, ...props }: ComponentProps<"button"> & { header?: boolean; round?: boolean }) {
  return (
    <button
      type="button"
      className={cx(
        "flex shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-all",
        "hover:text-foreground aria-expanded:text-foreground focus-visible:focus-ring motion-safe:active:scale-press",
        header ? cx("hover:bg-fill svg:size-icon-sm", round ? "size-5.5 rounded-full" : "size-icon-button-sm rounded-control") : "h-5 w-5.25 rounded-xs svg:size-icon-sm",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A row's hover actions, over its end. They stay while a menu they opened is open. The row must keep its
 * hover look while the pointer is on them: style it with `group-hover/row:` as NavRow does.
 */
export function RowActionsSlot({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cx(
        "pointer-events-none absolute inset-y-0 end-2 flex items-center gap-1 opacity-0",
        "group-has-focus-visible/row:pointer-events-auto group-has-focus-visible/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100",
        "has-aria-expanded:pointer-events-auto has-aria-expanded:opacity-100",
        className,
      )}
    >
      {children}
    </div>
  );
}
