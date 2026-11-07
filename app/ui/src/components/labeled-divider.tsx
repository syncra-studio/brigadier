import type { ComponentProps } from "react";

import { cx } from "./cx";

/** Words across the column between two hairlines ("Usage limit reset · 9:39 PM"). */
export function LabeledDivider({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="labeled-divider" {...props} className={cx("flex items-center gap-3 self-stretch py-2 text-sm text-muted-foreground", className)}>
      <span aria-hidden className="h-px flex-1 bg-border" />
      {children}
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}
