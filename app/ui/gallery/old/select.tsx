import { Menu } from "@base-ui/react/menu";
import { type ComponentProps, type ReactNode, useId } from "react";

import { Check, ChevronDown } from "../../src/icons";
import { cx } from "../../src/components/cx";
import { DropdownMenuRadioItem, menuSurface } from "./menu";
import { spacingPx } from "../../src/components/tooltip";

/**
 * A select's pill on its own, for a menu of other contents (as a menu trigger's `render`): an optional
 * icon, its value (grey while it is a `placeholder`), a chevron. A screen reader names it by its `label`
 * and then the value it shows ("Theme, Dark"): a button has no value of its own to announce.
 */
export function SelectTrigger({
  label,
  icon,
  placeholder = false,
  className,
  children,
  id,
  ...props
}: {
  /** The accessible name, usually the row's label. */
  label: string;
  icon?: ReactNode;
  placeholder?: boolean;
  children: ReactNode;
} & Omit<ComponentProps<"button">, "children" | "aria-label" | "aria-labelledby">) {
  const own = useId();
  const value = useId();
  // The menu's trigger gives the button its id, when it is one, since the menu is named after it.
  const named = id ?? own;
  return (
    <button
      type="button"
      data-slot="select-trigger"
      {...props}
      id={named}
      aria-label={label}
      aria-labelledby={`${named} ${value}`}
      className={cx(
        "inline-flex h-control-sm max-w-full min-w-0 shrink-0 items-center rounded-capsule border border-divider bg-fill-faint px-3",
        "text-label transition-colors hover:bg-fill-subtle data-popup-open:bg-fill-subtle",
        "disabled:opacity-disabled",
        icon ? "gap-2" : "gap-1",
        className,
      )}
    >
      {icon}
      <span id={value} className={cx("min-w-0 flex-1 truncate text-start", placeholder && "text-muted-foreground")}>
        {children}
      </span>
      <ChevronDown aria-hidden className="size-icon-sm shrink-0 text-muted-foreground" />
    </button>
  );
}

export type SelectOption<T extends string> = {
  value: T;
  label: ReactNode;
  /** A grey line under the label. */
  hint?: ReactNode;
  /** What the pill shows when chosen, if not the label. */
  shown?: ReactNode;
};

/**
 * One of several choices in a menu, shown as a pill with the chosen one's label (or its `shown` words).
 * `className` sizes the pill; the menu is at least as wide.
 */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  id,
  icon,
  align = "end",
  className,
  open,
  container,
  collisionAvoidance,
}: {
  label: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  id?: string;
  icon?: ReactNode;
  align?: "start" | "end";
  className?: string;
  /** Held open (or shut) from outside. */
  open?: boolean;
  /** Where the menu is placed in the page; the body by default. */
  container?: Menu.Portal.Props["container"];
  /** How the menu keeps in view; it flips and shifts by default. */
  collisionAvoidance?: Menu.Positioner.Props["collisionAvoidance"];
}) {
  const chosen = options.find((option) => option.value === value);
  return (
    <Menu.Root modal={false} open={open}>
      <Menu.Trigger
        disabled={disabled}
        render={
          <SelectTrigger id={id} label={label} icon={icon} className={className}>
            {chosen?.shown ?? chosen?.label}
          </SelectTrigger>
        }
      />
      <Menu.Portal container={container}>
        <Menu.Positioner className="z-popup outline-none" align={align} sideOffset={spacingPx} collisionAvoidance={collisionAvoidance}>
          <Menu.Popup data-slot="select-content" className={cx(menuSurface, "max-h-select max-w-select min-w-anchor overflow-y-auto")}>
            <Menu.RadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
              {options.map((option) => (
                <DropdownMenuRadioItem
                  key={option.value}
                  value={option.value}
                  indicator={<Check className="size-icon-md" />}
                  className={option.hint ? "py-2" : undefined}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{option.label}</span>
                    {option.hint && <span className="text-xs whitespace-normal text-muted-foreground">{option.hint}</span>}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
