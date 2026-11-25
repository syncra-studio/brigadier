import { Toggle as BaseToggle } from "@base-ui/react/toggle";
import { ToggleGroup as BaseToggleGroup } from "@base-ui/react/toggle-group";
import type { ReactNode } from "react";

import { cx } from "./cx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/** A row of choices, one picked at a time (no look of its own). */
export const SegmentedRoot = BaseToggleGroup;
/** One choice in a `SegmentedRoot` (no look of its own). */
export const Segment = BaseToggle;

/**
 * `tip` names a choice whose label is only an icon, and shows as its tooltip.
 */
export type Choice<T extends string> = {
  value: T;
  label: ReactNode;
  tip?: string;
};

/**
 * One of a few choices as pills side by side; the chosen one is filled. With `fill` the pills share the
 * whole width, on a track. Exactly one is chosen: pressing the chosen pill again keeps it.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  fill = false,
  className,
}: {
  label: string;
  value: T;
  options: readonly Choice<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  fill?: boolean;
  className?: string;
}) {
  return (
    <SegmentedRoot
      aria-label={label}
      value={[value]}
      disabled={disabled}
      onValueChange={([next]) => {
        if (next !== undefined) onChange(next as T);
      }}
      className={cx("flex max-w-full min-w-0 items-center gap-0.5", fill && "w-full rounded-capsule bg-fill-subtle p-0.5", className)}
    >
      {options.map((option) => {
        const segment = (
          <Segment
            key={option.value}
            value={option.value}
            aria-label={option.tip}
            className={cx(
              "h-6 shrink-0 cursor-pointer rounded-capsule border border-transparent px-2 text-label whitespace-nowrap text-faint-foreground transition-colors",
              "hover:text-foreground focus-visible:focus-ring data-pressed:text-foreground disabled:cursor-not-allowed disabled:opacity-disabled",
              fill ? "min-w-0 flex-auto truncate data-pressed:bg-fill-hover" : "data-pressed:bg-fill-subtle",
            )}
          >
            {option.label}
          </Segment>
        );
        return option.tip ? (
          <Tooltip key={option.value}>
            <TooltipTrigger render={segment} />
            <TooltipContent>{option.tip}</TooltipContent>
          </Tooltip>
        ) : (
          segment
        );
      })}
    </SegmentedRoot>
  );
}
