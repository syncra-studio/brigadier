import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";

import { cx } from "./cx";

/** How long the pointer rests on a titlebar button before its tip shows; the next tip in the group then shows at once. */
const TITLEBAR_TIP_DELAY_MS = 250;

/** Shares one tip timing across the tooltips inside it. The app's default: tips show at once. */
export function TooltipProvider({ delay = 0, ...props }: BaseTooltip.Provider.Props) {
  return <BaseTooltip.Provider delay={delay} {...props} />;
}

/** The titlebar's icon buttons share one tip timing: wrap a group of them in this. */
export function TitlebarTips({ children }: { children: ReactNode }) {
  return <TooltipProvider delay={TITLEBAR_TIP_DELAY_MS}>{children}</TooltipProvider>;
}

/**
 * A tip closes once the pointer leaves its control: a hoverable one stayed open on the way to it and
 * hid the next control's own tip.
 */
export function Tooltip(props: BaseTooltip.Root.Props) {
  return <BaseTooltip.Root disableHoverablePopup {...props} />;
}

export const TooltipTrigger = BaseTooltip.Trigger;

// One spacing step from the trigger, read from the theme.
function spacingPx(): number {
  const root = getComputedStyle(document.documentElement);
  return parseFloat(root.getPropertyValue("--spacing")) * parseFloat(root.fontSize);
}

type TooltipContentProps = Omit<BaseTooltip.Popup.Props, "className"> &
  Pick<BaseTooltip.Positioner.Props, "side" | "align" | "collisionAvoidance"> & {
    className?: string;
    /** Where the tip is placed in the page; the body by default. */
    container?: BaseTooltip.Portal.Props["container"];
  };

export function TooltipContent({ className, side = "top", align, collisionAvoidance, container, ...props }: TooltipContentProps) {
  return (
    <BaseTooltip.Portal container={container}>
      <BaseTooltip.Positioner
        side={side}
        align={align}
        collisionAvoidance={collisionAvoidance}
        sideOffset={spacingPx}
        className="z-popup"
      >
        <BaseTooltip.Popup
          data-slot="tooltip"
          className={cx(
            // Never under the pointer: a tip sliding in over its own control would close it.
            "pointer-events-none popup-motion",
            "inline-flex w-fit max-w-80 items-center gap-1.5 rounded-tooltip border border-border bg-popover px-3 py-1.25",
            "text-center text-sm tracking-tooltip text-foreground shadow-tooltip has-kbd:pe-1.5",
            className,
          )}
          {...props}
        />
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  );
}
