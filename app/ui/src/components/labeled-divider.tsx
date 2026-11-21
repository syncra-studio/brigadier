import type { ComponentProps } from "react";

import { cx } from "./cx";

/** Words across the column between two hairlines ("Usage limit reset · 9:39 PM"), in the rows' grey [D119]. */
export function LabeledDivider({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="labeled-divider" {...props} className={cx("flex items-center gap-3 self-stretch py-2 text-sm leading-5.25 text-row-foreground", className)}>
      <span aria-hidden className="h-px flex-1 bg-border" />
      {children}
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}
