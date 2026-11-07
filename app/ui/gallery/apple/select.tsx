// The select as a macOS pop-up button, as Apple might draw it (D40): an approximation, gallery-only.
// Its menu opens with the chosen row over the button, as macOS does.
import { Select as BaseSelect } from "@base-ui/react/select";
import { type ComponentProps, type ReactNode, useId, useRef } from "react";

import { cx } from "../../src/components/cx";
import { Check } from "../../src/icons";
import { menuSurface } from "./menu";

/** The pop-up button's up-and-down chevrons, drawn by us. */
function Chevrons(props: ComponentProps<"svg">) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <path d="m5 6 3-3 3 3M5 10l3 3 3-3" />
    </svg>
  );
}

/** A filled capsule: an optional icon, its value (grey while a `placeholder`), the chevrons. */
export function SelectTrigger({
  label,
  icon,
  placeholder = false,
  className,
  children,
  id,
  ...props
}: {
  label: string;
  icon?: ReactNode;
  placeholder?: boolean;
  children: ReactNode;
} & Omit<ComponentProps<"button">, "children" | "aria-label" | "aria-labelledby">) {
  const own = useId();
  const value = useId();
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
        "inline-flex h-control-xs max-w-full min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-capsule bg-apple-button ps-2.5 pe-1.5",
        "text-label outline-none transition-colors hover:bg-apple-button-hover focus-visible:outline-3 focus-visible:outline-solid focus-visible:outline-apple-focus",
        "disabled:opacity-disabled svg:size-icon-sm",
        className,
      )}
    >
      {icon}
      <span id={value} className={cx("min-w-0 flex-1 truncate text-start", placeholder && "text-muted-foreground")}>
        {children}
      </span>
      <Chevrons className="size-icon-sm shrink-0 text-muted-foreground" />
    </button>
  );
}

export type SelectOption<T extends string> = {
  value: T;
  label: ReactNode;
  hint?: ReactNode;
  shown?: ReactNode;
};

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
  open?: boolean;
  container?: BaseSelect.Portal.Props["container"];
  collisionAvoidance?: BaseSelect.Positioner.Props["collisionAvoidance"];
}) {
  const chosen = options.find((option) => option.value === value);
  const popup = useRef<HTMLDivElement>(null);
  // The chosen row's middle on the button's middle. Base UI's own way (alignItemWithTrigger) measures the
  // window once on opening and gives up near its edges or inside a moved box, as the gallery's held ones are.
  const overButton = ({ anchor }: { anchor: { height: number } }) => {
    const row = popup.current?.querySelector<HTMLElement>("[data-selected]");
    return row ? -(anchor.height / 2 + row.offsetTop + row.offsetHeight / 2) : 0;
  };
  return (
    <BaseSelect.Root value={value} onValueChange={(next) => onChange(next as T)} open={open} modal={false} disabled={disabled}>
      <BaseSelect.Trigger
        render={
          <SelectTrigger id={id} label={label} icon={icon} className={className}>
            {chosen?.shown ?? chosen?.label}
          </SelectTrigger>
        }
      />
      <BaseSelect.Portal container={container}>
        <BaseSelect.Positioner
          className="z-popup outline-none"
          alignItemWithTrigger={false}
          align={align}
          sideOffset={overButton}
          // The rows' words start where the button's do.
          alignOffset={align === "start" ? -14 : 0}
          collisionAvoidance={collisionAvoidance}
        >
          <BaseSelect.Popup ref={popup} data-slot="select-content" className={cx(menuSurface, "max-h-select max-w-select min-w-anchor overflow-y-auto")}>
            <BaseSelect.List>
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  className={cx(
                    "group relative flex min-h-apple-row cursor-default items-center rounded-apple-menu-item ps-6 pe-2.5 outline-none select-none",
                    "highlighted:bg-apple-accent highlighted:text-apple-on-accent",
                    option.hint ? "py-1" : undefined,
                  )}
                >
                  <BaseSelect.ItemIndicator className="pointer-events-none absolute start-1.5 flex items-center">
                    <Check className="size-icon-xs" />
                  </BaseSelect.ItemIndicator>
                  <span className="flex min-w-0 flex-col">
                    <BaseSelect.ItemText className="truncate">{option.label}</BaseSelect.ItemText>
                    {option.hint && (
                      <span className="text-2xs whitespace-normal text-muted-foreground group-highlighted:text-apple-on-accent">{option.hint}</span>
                    )}
                  </span>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
