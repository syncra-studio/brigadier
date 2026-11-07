import { Button as BaseButton } from "@base-ui/react/button";

import { cx } from "../../src/components/cx";

const VARIANTS = {
  default: "bg-primary text-primary-fg hover:bg-primary-hover",
  destructive: "bg-destructive-fill text-foreground hover:bg-destructive-fill-hover",
  outline: "bg-fill text-foreground hover:bg-muted",
  secondary: "bg-muted text-foreground hover:bg-popover",
  ghost: "hover:bg-fill hover:text-foreground",
  link: "text-primary underline-offset-link hover:underline",
  // A row's action in a card: a faint wash, the label's regular type.
  soft: "bg-fill-subtle text-foreground hover:bg-fill-hover",
  // The same, for an action that deletes or removes.
  "soft-destructive": "bg-destructive-wash text-destructive hover:bg-destructive-wash-hover",
  // Blue words that act (Show all, Add model).
  "link-blue": "text-link hover:underline",
};

// Buttons with words are capsules; icon buttons have the icon-button corner.
const SIZES = {
  md: "rounded-capsule h-control-md px-3.5 gap-1.5 svg:size-icon-md",
  xs: "rounded-capsule h-control-xs px-2 gap-1 svg:size-icon-xs",
  sm: "rounded-capsule h-control-sm px-2.5 gap-1 svg:size-icon-md",
  // Words with no box of their own (a row's "Show all").
  inline: "h-auto gap-1 p-0 svg:size-icon-xs",
  icon: "rounded-icon-button size-control-md svg:size-icon-md",
  "icon-xs": "rounded-icon-button size-5 svg:size-icon-xs",
  "icon-sm": "rounded-icon-button size-control-xs svg:size-icon-sm",
  "icon-md": "rounded-icon-button size-control-sm svg:size-icon-md",
};

// Each property is set once (cx doesn't merge): small sizes take the small type, soft looks the label's regular type.
function typeClasses(variant: ButtonProps["variant"], size: ButtonProps["size"]): string {
  if (size === "xs" || size === "inline") return "text-xs font-medium";
  if (variant === "soft" || variant === "soft-destructive") return "text-label font-normal";
  return "text-sm font-medium";
}

export type ButtonProps = Omit<BaseButton.Props, "className"> & {
  className?: string;
  /** `null` leaves the look to the caller (an icon button's strip look). */
  variant?: keyof typeof VARIANTS | null;
  size?: keyof typeof SIZES | null;
};

export function Button({ className, variant = "default", size = "md", type = "button", ...props }: ButtonProps) {
  return (
    <BaseButton
      data-slot="button"
      // A button submits its form only when it says so: Enter in any field clicks an untyped one.
      type={type}
      className={cx(
        "shrink-0 items-center justify-center whitespace-nowrap focus-visible:focus-ring",
        "disabled:pointer-events-none disabled:opacity-disabled svg:pointer-events-none svg:shrink-0",
        typeClasses(variant, size),
        variant && VARIANTS[variant],
        // No size leaves the box and its motion to the caller (an icon button's strip look).
        size ? cx("inline-flex transition-all", SIZES[size]) : "svg:size-icon-md",
        className,
      )}
      {...props}
    />
  );
}
