import type { ReactNode } from "react";

import { Info } from "../icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible";
import { cx } from "./cx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/**
 * An error the daemon (or validation) reported, shown where it happened. Nothing when there is none.
 * `size="sm"` matches WorkingLine, for a run's status line. With `actions` it keeps to one line: the
 * error truncates, an ⓘ after it shows the whole error (tooltip on hover or focus, opened under the line
 * on click), and the actions stay at the end.
 */
export function ErrorLine({
  error,
  size = "xs",
  actions,
  className,
}: {
  error: string | null | undefined;
  size?: "xs" | "sm";
  actions?: ReactNode;
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
  return (
    <Collapsible className={cx(text, "flex max-w-full min-w-0 flex-col text-destructive", className)}>
      <p className="flex max-w-full min-w-0 items-center gap-x-1.5">
        <span role="alert" className="min-w-0 truncate">
          {error}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <CollapsibleTrigger
                aria-label="Show the whole error"
                className="flex shrink-0 cursor-pointer rounded-control focus-visible:focus-ring svg:size-icon-sm"
              >
                <Info />
              </CollapsibleTrigger>
            }
          />
          <TooltipContent>{error}</TooltipContent>
        </Tooltip>
        <span className="flex shrink-0 items-center gap-x-2 ps-0.5">{actions}</span>
      </p>
      {/* No role: the line above already announced it. */}
      <CollapsibleContent className="whitespace-pre-wrap wrap-anywhere">{error}</CollapsibleContent>
    </Collapsible>
  );
}
