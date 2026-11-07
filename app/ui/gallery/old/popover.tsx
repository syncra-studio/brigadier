import { Popover as BasePopover } from "@base-ui/react/popover";

import { cx } from "../../src/components/cx";
import { spacingPx } from "../../src/components/tooltip";

export const Popover = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;

type PopoverContentProps = Omit<BasePopover.Popup.Props, "className"> &
  Pick<BasePopover.Positioner.Props, "side" | "align" | "sideOffset" | "alignOffset" | "collisionAvoidance" | "anchor"> & {
    className?: string;
    /** Where the popover is placed in the page; the body by default. */
    container?: BasePopover.Portal.Props["container"];
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
            "rounded-overlay bg-popover p-1 text-foreground shadow-overlay ring ring-border outline-none menu-motion",
            className,
          )}
          {...props}
        />
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}
