import type { ComponentProps, ReactNode } from "react";

import { cx } from "./cx";

/** An icon button on a row's end, shown while the row (marked `group/row`) is hovered or focused. Name it with `aria-label`. */
export function RowAction({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cx(
        "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-all",
        "hover:text-foreground focus-visible:focus-ring motion-safe:active:scale-press svg:size-icon-md",
        className,
      )}
      {...props}
    />
  );
}

/** A row's hover actions, over its end. They stay while a menu they opened is open. */
export function RowActionsSlot({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cx(
        "pointer-events-none absolute inset-y-0 end-1.5 flex items-center gap-2 opacity-0",
        "group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100",
        "has-aria-expanded:pointer-events-auto has-aria-expanded:opacity-100",
        className,
      )}
    >
      {children}
    </div>
  );
}
