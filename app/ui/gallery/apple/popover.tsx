// The popover as Apple might draw it on macOS (D40): an approximation, gallery-only.
import { Popover as BasePopover } from "@base-ui/react/popover";

import { cx } from "../../src/components/cx";
import { spacingPx } from "../../src/components/tooltip";

export const Popover = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;

// The arrow's height (theme.css spacing-apple-arrow).
const ARROW_PX = 8;

type PopoverContentProps = Omit<BasePopover.Popup.Props, "className"> &
  Pick<BasePopover.Positioner.Props, "side" | "align" | "sideOffset" | "alignOffset" | "collisionAvoidance" | "anchor"> & {
    className?: string;
    container?: BasePopover.Portal.Props["container"];
  };

/** See-through material with an arrow pointing at its trigger. */
export function PopoverContent({
  className,
  container,
  side,
  align,
  sideOffset = () => ARROW_PX + spacingPx() / 2,
  alignOffset,
  collisionAvoidance,
  anchor,
  children,
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
            "rounded-apple-popover bg-material p-1.5 text-label text-foreground shadow-material outline-none backdrop-blur-material apple-menu-motion",
            className,
          )}
          {...props}
        >
          <BasePopover.Arrow className="flex text-material apple-arrow">
            <svg viewBox="0 0 16 8" className="size-full fill-current" aria-hidden>
              <path d="M0 8 7 1a1.4 1.4 0 0 1 2 0l7 7Z" />
            </svg>
          </BasePopover.Arrow>
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}
