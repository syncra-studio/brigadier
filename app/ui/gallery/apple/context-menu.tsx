import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";

import { cx } from "../../src/components/cx";
import { menuSurface, type MenuContentProps } from "./menu";

// Its rows are the dropdown menu's: the same parts and looks.
export {
  DropdownMenuItem as ContextMenuItem,
  DropdownMenuSeparator as ContextMenuSeparator,
  DropdownMenuSub as ContextMenuSub,
  DropdownMenuSubTrigger as ContextMenuSubTrigger,
} from "./menu";

/** A menu opened by a right-click (or the context-menu key) on its trigger, styled like the others. */
export const ContextMenu = BaseContextMenu.Root;
export const ContextMenuTrigger = BaseContextMenu.Trigger;

export function ContextMenuContent({
  className,
  container,
  side,
  align,
  sideOffset,
  alignOffset,
  collisionAvoidance,
  anchor,
  ...props
}: MenuContentProps) {
  return (
    <BaseContextMenu.Portal container={container}>
      <BaseContextMenu.Positioner
        className="z-popup outline-none"
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionAvoidance={collisionAvoidance}
        anchor={anchor}
      >
        <BaseContextMenu.Popup
          data-slot="context-menu-content"
          className={cx(menuSurface, "max-h-available overflow-x-hidden overflow-y-auto", className)}
          {...props}
        />
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  );
}

/** A sub-menu's surface ("Open in ›"), beside its row. */
export const ContextMenuSubContent = ContextMenuContent;
