import { Progress } from "@base-ui/react/progress";
import type { ComponentProps, ReactNode } from "react";

import { Check, ExclamationMarkCircle, Spinner, X } from "../icons";
import { cx } from "./cx";

/**
 * A line and a bar for work counted in units (a download, an upload): the line says what is at work and
 * what is left, the bar fills by the share done, and once it ends a receipt takes its place.
 */
export type ProgressOutcomeStatus = "success" | "partial" | "failed" | "cancelled";

const OUTCOME_BAR: Record<ProgressOutcomeStatus, string> = {
  success: "bg-success",
  partial: "bg-warning",
  failed: "bg-destructive",
  cancelled: "bg-progress-cancelled",
};

function OutcomeMark({ status }: { status: ProgressOutcomeStatus | undefined }) {
  const mark = "size-icon-sm shrink-0";
  if (status === "partial") return <ExclamationMarkCircle className={cx(mark, "text-warning")} />;
  if (status === "failed") return <X className={cx(mark, "text-destructive")} />;
  if (status === "cancelled") return <X className={cx(mark, "text-muted-foreground")} />;
  if (status === "success") return <Check className={cx(mark, "text-success")} />;
  return <Spinner className={cx(mark, "text-muted-foreground motion-safe:animate-spin")} />;
}

export function ProgressLine({
  title,
  done,
  total,
  meta,
  description,
  outcome,
  icon = true,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "title"> & {
  /** The stage at work ("Phase 2 of 3 · Fix"), or the job once it ended. */
  title: string;
  /** Units finished, of `total`. */
  done: number;
  total: number;
  /** At the line's end: what is left while it runs ("until 07:30"), how long it took after. */
  meta?: ReactNode;
  /** What the stage at work is doing, in a line. */
  description?: ReactNode;
  outcome?: { status: ProgressOutcomeStatus; summary?: string };
  /** The spinner, or the outcome's mark, before the line; off where the line alone says it. */
  icon?: boolean;
}) {
  const share = total > 0 && !Number.isNaN(done) ? Math.min(100, Math.max(0, (done / total) * 100)) : 0;
  const progress = outcome?.status === "success" ? 100 : share;
  return (
    <div data-slot="progress-line" data-state={outcome?.status ?? "running"} className={cx("flex w-full min-w-0 flex-col gap-2 text-sm", className)} {...props}>
      <div className="flex min-w-0 items-center gap-2">
        {icon && <OutcomeMark status={outcome?.status} />}
        <span className={cx("min-w-0 flex-1 truncate", !outcome && "shimmer")}>{title}</span>
        {meta && <span className="shrink-0 font-mono text-2xs tracking-tight text-muted-foreground tabular-nums">{meta}</span>}
      </div>
      <Progress.Root value={Math.round(progress)} aria-label={`${title} progress`}>
        <Progress.Track className="block h-0.5 w-full overflow-hidden rounded-capsule bg-fill-hover">
          {/* Base UI sets the bar's width. */}
          <Progress.Indicator
            className={cx(
              "block h-full rounded-capsule motion-safe:transition-width",
              outcome ? OUTCOME_BAR[outcome.status] : "bg-progress",
            )}
          />
        </Progress.Track>
      </Progress.Root>
      {description && <div className="text-xs wrap-anywhere text-muted-foreground">{description}</div>}
      {outcome?.summary && <p className="text-sm wrap-anywhere">{outcome.summary}</p>}
    </div>
  );
}
