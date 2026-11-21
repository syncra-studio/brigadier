import { Popover as BasePopover } from "@base-ui/react/popover";

import { cx } from "./cx";
import { spacingPx } from "./tooltip";

export const Popover = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;

type PopoverContentProps = Omit<BasePopover.Popup.Props, "className"> &
  Pick<BasePopover.Positioner.Props, "side" | "align" | "sideOffset" | "alignOffset" | "collisionAvoidance" | "anchor"> & {
    className?: string;
    /** Where the popover is placed in the page; the body by default. */
    container?: BasePopover.Portal.Props["container"];
    /** `false`: no padding, for a panel that lays out its own edges (the model picker). */
    padded?: boolean;
  };

/** A floating card by its trigger, or by `anchor` when something else places it. */
export function PopoverContent({
  className,
  container,
  side,
  align,
  // One spacing step from the trigger.
  sideOffset = spacingPx,
  alignOffset,
  collisionAvoidance,
  anchor,
  padded = true,
  ...props
}: PopoverContentProps) {
  return (
    <BasePopover.Portal container={container}>
      <BasePopover.Positioner
        className="z-popup"
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionAvoidance={collisionAvoidance}
        anchor={anchor}
      >
        <BasePopover.Popup
          data-slot="popover-content"
          className={cx(
            "rounded-surface bg-menu text-foreground shadow-overlay backdrop-blur-popover outline-none menu-motion",
            padded && "p-1",
            className,
          )}
          {...props}
        />
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}
