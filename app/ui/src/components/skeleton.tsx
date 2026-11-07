import type { ComponentProps } from "react";

import { cx } from "./cx";

/** A grey block pulsing where content will load. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="skeleton" className={cx("animate-pulse rounded-control bg-muted motion-reduce:animate-none", className)} {...props} />;
}
