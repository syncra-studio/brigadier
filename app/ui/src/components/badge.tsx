import type { ComponentProps } from "react";

import { cx } from "./cx";

const VARIANTS = {
  default: "bg-primary text-primary-fg",
  secondary: "bg-muted text-foreground",
  destructive: "bg-destructive-fill text-foreground",
  warning: "bg-warning-wash text-warning",
  success: "bg-success-wash text-success",
  outline: "border-border text-foreground",
};

export function Badge({ className, variant = "default", ...props }: ComponentProps<"span"> & { variant?: keyof typeof VARIANTS }) {
  return (
    <span
      data-slot="badge"
      className={cx(
        "inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-capsule border border-transparent px-2 text-xs font-medium whitespace-nowrap",
        "svg:pointer-events-none svg:size-icon-xs",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
