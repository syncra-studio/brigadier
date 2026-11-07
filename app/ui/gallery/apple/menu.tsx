// The dropdown menu as Apple might draw it on macOS (D40): an approximation, gallery-only.
import { Menu } from "@base-ui/react/menu";
import type { ComponentProps, ReactNode } from "react";

import { cx } from "../../src/components/cx";
import { spacingPx } from "../../src/components/tooltip";
import { Check, ChevronRight } from "../../src/icons";

/** See-through material, a hairline edge, a soft shadow, rounder corners, 13px words. */
export const menuSurface = cx(
  "z-popup min-w-menu rounded-apple-menu bg-apple-material p-apple-menu-pad text-label text-foreground shadow-apple-material",
  "outline-none backdrop-blur-material apple-menu apple-menu-motion",
);

// A row: the accent blue with white words when highlighted, dimmed when off, the arrow cursor.
export const itemBase = cx(
  "group relative flex min-h-apple-row cursor-default items-center gap-1.5 rounded-apple-menu-item outline-none select-none apple-row",
  "highlighted:bg-apple-accent highlighted:text-apple-on-accent data-disabled:text-apple-disabled",
  "svg:pointer-events-none svg:shrink-0 svg:size-icon-sm",
);

export const itemClasses = cx(
  itemBase,
  "pe-2.5 destructive:text-destructive destructive:highlighted:bg-destructive destructive:highlighted:text-apple-on-accent",
);

type Positioning = Pick<Menu.Positioner.Props, "side" | "align" | "sideOffset" | "alignOffset" | "collisionAvoidance" | "anchor">;

export type MenuContentProps = Omit<Menu.Popup.Props, "className"> &
  Positioning & {
    className?: string;
    container?: Menu.Portal.Props["container"];
  };

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuRadioGroup = Menu.RadioGroup;
export const DropdownMenuSub = Menu.SubmenuRoot;

export function DropdownMenuContent({
  className,
  container,
  side,
  align,
  sideOffset = spacingPx,
  alignOffset,
  collisionAvoidance,
  anchor,
  ...props
}: MenuContentProps) {
  return (
    <Menu.Portal container={container}>
      <Menu.Positioner
        className="z-popup outline-none"
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionAvoidance={collisionAvoidance}
        anchor={anchor}
      >
        <Menu.Popup
          data-slot="dropdown-menu-content"
          className={cx(menuSurface, "max-h-available overflow-x-hidden overflow-y-auto", className)}
          {...props}
        />
      </Menu.Positioner>
    </Menu.Portal>
  );
}

export function DropdownMenuItem({
  className,
  inset: _inset,
  variant = "default",
  ...props
}: Omit<Menu.Item.Props, "className"> & { className?: string; inset?: boolean; variant?: "default" | "destructive" }) {
  return <Menu.Item data-slot="dropdown-menu-item" data-variant={variant} className={cx(itemClasses, className)} {...props} />;
}

// A checkmark on the leading edge, macOS's mark for both checkbox and radio rows.
const MARK = "pointer-events-none absolute start-1.5 flex items-center justify-center";

export function DropdownMenuCheckboxItem({
  className,
  children,
  closeOnClick = true,
  ...props
}: Omit<Menu.CheckboxItem.Props, "className"> & { className?: string }) {
  return (
    <Menu.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      closeOnClick={closeOnClick}
      className={cx(itemBase, "pe-2.5", className)}
      {...props}
    >
      <Menu.CheckboxItemIndicator className={MARK}>
        <Check className="size-icon-xs" />
      </Menu.CheckboxItemIndicator>
      {children}
    </Menu.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  indicator: _indicator,
  closeOnClick = true,
  ...props
}: Omit<Menu.RadioItem.Props, "className"> & { className?: string; indicator?: ReactNode }) {
  return (
    <Menu.RadioItem
      data-slot="dropdown-menu-radio-item"
      closeOnClick={closeOnClick}
      className={cx(itemBase, "pe-2.5", className)}
      {...props}
    >
      <Menu.RadioItemIndicator className={MARK}>
        <Check className="size-icon-xs" />
      </Menu.RadioItemIndicator>
      {children}
    </Menu.RadioItem>
  );
}

/** A section's small bold grey heading; both variants look the same on macOS. */
export function DropdownMenuLabel({
  className,
  inset: _inset,
  variant: _variant,
  ...props
}: ComponentProps<"div"> & { inset?: boolean; variant?: "caps" | "heading" }) {
  return (
    <div
      data-slot="dropdown-menu-label"
      className={cx("pt-1.5 pe-2.5 pb-0.5 text-2xs font-semibold text-muted-foreground apple-row", className)}
      {...props}
    />
  );
}

/** A thin line, inset from the menu's sides. */
export function DropdownMenuSeparator({ className, ...props }: Omit<Menu.Separator.Props, "className"> & { className?: string }) {
  return <Menu.Separator data-slot="dropdown-menu-separator" className={cx("mx-2.5 my-1 h-px bg-border", className)} {...props} />;
}

const QUIET = "text-muted-foreground group-data-highlighted:text-apple-on-accent";

export function DropdownMenuShortcut({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="dropdown-menu-shortcut" className={cx("ms-auto ps-4", QUIET, className)} {...props} />;
}

/** A row that opens a sub-menu; it stays blue while the sub-menu is open, as on macOS. */
export function DropdownMenuSubTrigger({
  className,
  inset: _inset,
  children,
  ...props
}: Omit<Menu.SubmenuTrigger.Props, "className"> & { className?: string; inset?: boolean }) {
  return (
    <Menu.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cx(itemBase, "pe-1.5 data-popup-open:bg-apple-accent data-popup-open:text-apple-on-accent", className)}
      {...props}
    >
      {children}
      <ChevronRight className="ms-auto size-icon-xs rtl:rotate-180" />
    </Menu.SubmenuTrigger>
  );
}

/** A sub-menu, beside its row, its first row level with it. */
export function DropdownMenuSubContent({ sideOffset = 0, alignOffset = -5, ...props }: MenuContentProps) {
  return <DropdownMenuContent sideOffset={sideOffset} alignOffset={alignOffset} {...props} />;
}

/** What a row shows: an icon, its title, a grey detail and a hint, all white while highlighted. */
export function MenuRow({
  icon,
  title,
  detail,
  hint,
  mono = false,
  twoLine = false,
}: {
  icon?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  hint?: ReactNode;
  mono?: boolean;
  twoLine?: boolean;
}) {
  const end = hint !== undefined && hint !== null && hint !== false && (
    <span data-slot="menu-row-hint" className={cx("flex shrink-0 items-center gap-2", QUIET, !twoLine && "ms-auto ps-4", mono && "font-mono text-xs")}>
      {hint}
    </span>
  );
  return (
    <>
      {icon !== undefined && (
        <span data-slot="menu-row-icon" className="flex size-icon-sm shrink-0 items-center justify-center svg:size-icon-sm">
          {icon}
        </span>
      )}
      {twoLine ? (
        <span className="flex min-w-0 flex-1 flex-col py-0.5">
          <span className="flex min-w-0 gap-2">
            <span className="truncate">{title}</span>
            {end}
          </span>
          {detail && <span className={cx("truncate text-2xs", QUIET)}>{detail}</span>}
        </span>
      ) : (
        <>
          <span className={detail ? "shrink-0" : "min-w-0 flex-1 truncate"}>{title}</span>
          {detail && <span className={cx("min-w-0 flex-1 truncate", QUIET)}>{detail}</span>}
          {end}
        </>
      )}
    </>
  );
}
