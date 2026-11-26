import type { ReactNode } from "react";

import { Info } from "../icons";
import { cx } from "./cx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/**
 * An error the daemon (or validation) reported, shown where it happened. Nothing when there is none.
 * `size="sm"` matches WorkingLine, for a run's status line. With `actions` it keeps to one line: the
 * error truncates, an ⓘ after it shows the whole error in a tooltip (on hover or focus), and the actions
 * stay at the end. `wrap` lets it wrap instead, the actions following its last word, for a reason the user must read.
 */
export function ErrorLine({
  error,
  size = "xs",
  actions,
  wrap,
  className,
}: {
  error: string | null | undefined;
  size?: "xs" | "sm";
  actions?: ReactNode;
  wrap?: boolean;
  className?: string;
}) {
  if (!error) return null;
  const text = size === "sm" ? "text-sm leading-5.25" : "text-xs";
  if (actions === undefined) {
    return (
      <p role="alert" className={cx(text, "whitespace-pre-wrap text-destructive", className)}>
        {error}
      </p>
    );
  }
  if (wrap) {
    return (
      <p className={cx(text, "max-w-full text-destructive wrap-anywhere", className)}>
        <span role="alert">{error}</span>
        <span className="ms-2 inline-flex gap-x-2 align-baseline">{actions}</span>
      </p>
    );
  }
  return (
    <p className={cx(text, "flex max-w-full min-w-0 items-center gap-x-1.5 text-destructive", className)}>
      <span role="alert" className="min-w-0 truncate">
        {error}
      </span>
      <Tooltip>
        {/* Focusable, so the tip opens from the keyboard too; it names the whole error. */}
        <TooltipTrigger
          render={
            <span role="img" tabIndex={0} aria-label={error} className="flex shrink-0 rounded-control focus-visible:focus-ring svg:size-icon-sm">
              <Info />
            </span>
          }
        />
        <TooltipContent>{error}</TooltipContent>
      </Tooltip>
      <span className="flex shrink-0 items-center gap-x-2 ps-0.5">{actions}</span>
    </p>
  );
}
