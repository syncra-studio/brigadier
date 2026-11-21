import { Button, type ButtonProps } from "./button";
import { cx } from "./cx";
import { Kbd } from "./kbd";
import { spacingPx, Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

// A titlebar or pane-toolbar icon: a dim glyph that brightens on hover and shows pressed with a faint fill.
const TOOLBAR = cx(
  "rounded-icon-button text-toolbar-foreground hover:bg-fill hover:text-foreground focus-visible:text-foreground",
  "aria-expanded:bg-fill aria-expanded:text-foreground active:bg-fill-active svg:size-icon-md",
  "aria-pressed:bg-fill-subtle aria-pressed:text-foreground aria-pressed:hover:bg-fill-hover",
);

// A sidebar strip or foot icon: a row tall, filled while hovered, pressed or while its menu is open.
const STRIP = cx(
  "relative flex gap-1.5 text-strip-foreground transition-all motion-safe:active:scale-press",
  "hover:bg-fill hover:text-foreground aria-expanded:bg-fill aria-expanded:text-foreground",
  "aria-pressed:bg-fill aria-pressed:text-foreground",
);

export type TooltipIconButtonProps = ButtonProps & {
  /** The tip, which also names the button for screen readers. */
  tooltip: string;
  /** The button's keyboard shortcut, as a pill after the tip. */
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
  /**
   * `ghost`: a quiet icon in a card, row or composer; its tip shows at once. `toolbar` and `strip` take their tip timing
   * from the provider around them (TitlebarTips, the sidebar). `rail`: the strip's 36 square, its tip a 30-tall pill 2px
   * beside it [D11]; `foot` the strip foot's smaller 32 [D190]. `head`: the sidebar header's 29×28 [D23 D24]. `bar`: the tab bar's 28 square, `chat`
   * the chat's own 28 circle (its …, Toggle pinned summary), `round` its 32 circle at the row's end, the chat
   * toolbar and Show tabs [D39 D40 D44 D200].
   */
  look?: "ghost" | "toolbar" | "strip" | "rail" | "foot" | "head" | "bar" | "chat" | "round";
  /** Switched on (aria-pressed). */
  pressed?: boolean;
  /** A small dot on the icon, in this background class ("bg-warning"). */
  dot?: string;
  /** `false` leaves the tip out. */
  tip?: boolean;
};

export function TooltipIconButton({
  children,
  tooltip,
  shortcut,
  side = "bottom",
  look = "ghost",
  pressed,
  dot,
  tip = true,
  size,
  variant,
  className,
  ...props
}: TooltipIconButtonProps) {
  const ghost = look === "ghost";
  const flat = look === "strip" || look === "rail" || look === "foot" || look === "head" || look === "bar" || look === "chat" || look === "round";
  const button = (
    <Button
      variant={flat ? null : (variant ?? "ghost")}
      size={flat ? null : (size ?? (ghost ? "icon-sm" : "icon-md"))}
      aria-label={tooltip}
      aria-pressed={pressed}
      className={cx(
        ghost && (variant ?? "ghost") === "ghost" && "aria-expanded:bg-fill",
        look === "toolbar" && TOOLBAR,
        flat && STRIP,
        look === "strip" && "h-7.5 min-w-8 rounded-icon-button",
        look === "head" && "h-7 w-7.25 justify-center rounded-icon-button",
        look === "rail" && "size-9 rounded-icon-button",
        look === "foot" && "size-8 rounded-icon-button svg:size-icon-sm",
        look === "bar" && "size-7 justify-center rounded-icon-button",
        look === "chat" && "size-7 justify-center rounded-capsule",
        look === "round" && "size-8 justify-center rounded-capsule",
        className,
      )}
      {...props}
    >
      {dot ? (
        <span className="relative flex shrink-0">
          {children}
          <span aria-hidden className={cx("absolute -end-0.5 -top-0.5 size-1.5 rounded-capsule", dot)} />
        </span>
      ) : (
        children
      )}
    </Button>
  );
  if (!tip) return button;
  return (
    <Tooltip>
      <TooltipTrigger delay={ghost ? 0 : undefined} render={button} />
      <TooltipContent side={side} {...((look === "rail" || look === "foot") && { sideOffset: spacingPx() / 2, className: "h-7.5" })}>
        {tooltip}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}
