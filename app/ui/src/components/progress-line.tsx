import { Progress } from "@base-ui/react/progress";
import type { ComponentProps, ReactNode } from "react";

import { cx } from "./cx";

/**
 * A line and a bar for work counted in units (a download, an upload): the line says what is at work, the bar
 * fills by the share done.
 */
export function ProgressLine({
  title,
  done,
  total,
  description,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "title"> & {
  /** The stage at work ("Phase 2 of 3 · Fix"). */
  title: string;
  /** Units finished, of `total`. */
  done: number;
  total: number;
  /** What the stage at work is doing, in a line. */
  description?: ReactNode;
}) {
  const share = total > 0 && !Number.isNaN(done) ? Math.min(100, Math.max(0, (done / total) * 100)) : 0;
  return (
    <div data-slot="progress-line" className={cx("flex w-full min-w-0 flex-col gap-2 text-sm", className)} {...props}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="shimmer min-w-0 flex-1 truncate">{title}</span>
      </div>
      <Progress.Root value={Math.round(share)} aria-label={`${title} progress`}>
        <Progress.Track className="block h-0.5 w-full overflow-hidden rounded-capsule bg-fill-hover">
          {/* Base UI sets the bar's width. */}
          <Progress.Indicator className="block h-full rounded-capsule bg-progress motion-safe:transition-width" />
        </Progress.Track>
      </Progress.Root>
      {description && <div className="text-xs wrap-anywhere text-muted-foreground">{description}</div>}
    </div>
  );
}
