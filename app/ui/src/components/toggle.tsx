import { Toggle as BaseToggle } from "@base-ui/react/toggle";
import { ToggleGroup as BaseToggleGroup } from "@base-ui/react/toggle-group";
import { createContext, useContext } from "react";

import { cx } from "./cx";

const VARIANTS = {
  default: "bg-transparent hover:text-muted-foreground",
  outline: "border border-input bg-transparent hover:text-foreground",
};
const SIZES = {
  default: "h-control-md min-w-control-md px-2.5",
  sm: "h-control-sm min-w-control-sm px-2",
  lg: "h-control-lg min-w-control-lg px-3.5",
};

type Look = { variant?: keyof typeof VARIANTS; size?: keyof typeof SIZES };

function toggleClasses({ variant = "default", size = "default" }: Look) {
  return cx(
    "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-control text-sm font-medium whitespace-nowrap transition-colors",
    "hover:bg-muted focus-visible:focus-ring data-pressed:bg-muted data-pressed:text-foreground",
    "aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-disabled svg:pointer-events-none svg:shrink-0 svg:size-icon-md",
    VARIANTS[variant],
    SIZES[size],
  );
}

/** A button that stays pressed until pressed again. */
export function Toggle({ className, variant, size, ...props }: Omit<BaseToggle.Props, "className"> & Look & { className?: string }) {
  return <BaseToggle data-slot="toggle" className={cx(toggleClasses({ variant, size }), className)} {...props} />;
}

type Spacing = "none" | "tight" | "loose";
const GAPS: Record<Spacing, string> = { none: "gap-0", tight: "gap-0.5", loose: "gap-1" };
const GroupLook = createContext<Look & { spacing: Spacing }>({ spacing: "none" });

/** Toggles side by side; with no spacing they join into one bar. `multiple` lets several stay pressed. */
export function ToggleGroup({
  className,
  variant,
  size,
  spacing = "none",
  children,
  ...props
}: Omit<BaseToggleGroup.Props, "className"> & Look & { spacing?: Spacing; className?: string }) {
  return (
    <BaseToggleGroup data-slot="toggle-group" className={cx("flex w-fit items-center rounded-control", GAPS[spacing], className)} {...props}>
      <GroupLook.Provider value={{ variant, size, spacing }}>{children}</GroupLook.Provider>
    </BaseToggleGroup>
  );
}

export function ToggleGroupItem({ className, variant, size, ...props }: Omit<BaseToggle.Props, "className"> & Look & { className?: string }) {
  const group = useContext(GroupLook);
  const look = group.variant ?? variant;
  const joined = group.spacing === "none";
  return (
    <BaseToggle
      data-slot="toggle-group-item"
      className={cx(
        toggleClasses({ variant: look, size: group.size ?? size }),
        "w-auto min-w-0 shrink-0 focus-visible:z-10",
        joined && "rounded-none first:rounded-s-control last:rounded-e-control",
        joined && look === "outline" && "border-s-0 first:border-s",
        className,
      )}
      {...props}
    />
  );
}
