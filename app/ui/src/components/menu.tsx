import { Menu } from "@base-ui/react/menu";
import type { ComponentProps, ReactNode } from "react";

import { Check, ChevronRight, Dot } from "../icons";
import { cx } from "./cx";
import { spacingPx } from "./tooltip";

/** A menu's surface; the context menu and the select share it. */
export const menuSurface = cx(
  "z-popup min-w-menu rounded-overlay bg-popover p-1 text-foreground shadow-overlay ring ring-popover-edge backdrop-blur-popover outline-none menu-motion",
);

// A menu row (a two-line one grows: give it `py-2`); the context menu shares it. Padding is set per side
// (cx doesn't merge): rows with a mark at the end keep room for it.
export const itemBase = cx(
  "relative flex min-h-control-sm cursor-pointer items-center gap-2 rounded-menu-item ps-2 text-sm outline-none select-none",
  "highlighted:bg-fill data-disabled:cursor-not-allowed data-disabled:opacity-disabled",
  "svg:pointer-events-none svg:shrink-0 svg:size-icon-md svg-uncoloured:text-muted-foreground data-inset:ps-8",
);

/** A plain row's look, its red variant and its icon colour; the context menu shares them. */
export const itemClasses = cx(
  itemBase,
  "pe-2 destructive:text-destructive destructive:highlighted:bg-destructive-wash-hover destructive:svg:text-destructive",
);

type Positioning = Pick<Menu.Positioner.Props, "side" | "align" | "sideOffset" | "alignOffset" | "collisionAvoidance" | "anchor">;

export type MenuContentProps = Omit<Menu.Popup.Props, "className"> &
  Positioning & {
    className?: string;
    /** Where the menu is placed in the page; the body by default. */
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
  // One spacing step from the trigger.
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
  inset,
  variant = "default",
  ...props
}: Omit<Menu.Item.Props, "className"> & { className?: string; inset?: boolean; variant?: "default" | "destructive" }) {
  return (
    <Menu.Item
      data-slot="dropdown-menu-item"
      data-inset={inset || undefined}
      data-variant={variant}
      className={cx(itemClasses, className)}
      {...props}
    />
  );
}

// The mark at a checkbox or radio row's end; an inset row's, in its inset at the start.
const MARK = "pointer-events-none absolute end-2 flex items-center justify-center in-data-inset:start-2 in-data-inset:end-auto";

// Picking a checkbox or radio row closes its menu, as the old app's menus did.
export function DropdownMenuCheckboxItem({
  className,
  children,
  inset,
  closeOnClick = true,
  ...props
}: Omit<Menu.CheckboxItem.Props, "className"> & { className?: string; inset?: boolean }) {
  return (
    <Menu.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset || undefined}
      closeOnClick={closeOnClick}
      className={cx(itemBase, "pe-8 data-inset:pe-2", className)}
      {...props}
    >
      <Menu.CheckboxItemIndicator className={MARK}>
        <Check className="size-icon-md" />
      </Menu.CheckboxItemIndicator>
      {children}
    </Menu.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  indicator,
  closeOnClick = true,
  ...props
}: Omit<Menu.RadioItem.Props, "className"> & {
  className?: string;
  /** What marks the chosen item (a dot by default). */
  indicator?: ReactNode;
}) {
  return (
    <Menu.RadioItem
      data-slot="dropdown-menu-radio-item"
      closeOnClick={closeOnClick}
      className={cx(itemBase, "pe-8", className)}
      {...props}
    >
      <Menu.RadioItemIndicator className={MARK}>{indicator ?? <Dot className="size-icon-md" />}</Menu.RadioItemIndicator>
      {children}
    </Menu.RadioItem>
  );
}

/**
 * A heading over a group of a menu's items: small mono capitals, or with `variant="heading"` plain grey
 * words ("Model", "Pinned"). It needs no menu around it (a popover's list uses it).
 */
export function DropdownMenuLabel({
  className,
  inset,
  variant = "caps",
  ...props
}: ComponentProps<"div"> & { inset?: boolean; variant?: "caps" | "heading" }) {
  return (
    <div
      data-slot="dropdown-menu-label"
      data-inset={inset || undefined}
      className={cx(
        "py-1.5 ps-2 pe-2 text-muted-foreground data-inset:ps-8",
        variant === "caps" ? "font-mono text-2xs font-medium tracking-wide uppercase" : "text-sm",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({ className, ...props }: Omit<Menu.Separator.Props, "className"> & { className?: string }) {
  return <Menu.Separator data-slot="dropdown-menu-separator" className={cx("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

export function DropdownMenuShortcut({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cx("ms-auto font-mono text-2xs tracking-wider text-muted-foreground", className)}
      {...props}
    />
  );
}

export function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: Omit<Menu.SubmenuTrigger.Props, "className"> & { className?: string; inset?: boolean }) {
  return (
    <Menu.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset || undefined}
      className={cx(itemBase, "pe-2 data-popup-open:bg-fill", className)}
      {...props}
    >
      {children}
      <ChevronRight className="ms-auto size-icon-md rtl:rotate-180" />
    </Menu.SubmenuTrigger>
  );
}

/** A sub-menu's surface, right beside its row. */
export function DropdownMenuSubContent({ sideOffset = 0, ...props }: MenuContentProps) {
  return <DropdownMenuContent sideOffset={sideOffset} {...props} />;
}

/**
 * What a row of a menu or a picker list shows: a 16px icon (its box kept when it has none), its title, a
 * grey detail after it (or under it with `twoLine`), and a hint at the end (a shortcut, a date; `mono` for
 * code). Put it inside the row's own item, which keeps its keys and highlight.
 */
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
    <span
      data-slot="menu-row-hint"
      className={cx("flex shrink-0 items-center gap-2 text-muted-foreground", !twoLine && "ms-auto text-xs", mono && "font-mono")}
    >
      {hint}
    </span>
  );
  return (
    <>
      {icon !== undefined && (
        <span data-slot="menu-row-icon" className="flex size-icon-md shrink-0 items-center justify-center text-muted-foreground svg:size-icon-md">
          {icon}
        </span>
      )}
      {twoLine ? (
        <span className="flex min-w-0 flex-1 flex-col py-1">
          <span className="flex min-w-0 gap-2">
            <span className="truncate">{title}</span>
            {end}
          </span>
          {detail && <span className="truncate text-xs text-muted-foreground">{detail}</span>}
        </span>
      ) : (
        <>
          <span className={detail ? "shrink-0" : "min-w-0 flex-1 truncate"}>{title}</span>
          {detail && <span className="min-w-0 flex-1 truncate text-muted-foreground">{detail}</span>}
          {end}
        </>
      )}
    </>
  );
}
