import { Button, type ButtonProps } from "./button";
import { cx } from "./cx";
import { Kbd } from "./kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

// A titlebar or pane-toolbar icon: a dim glyph that brightens on hover and shows pressed with a faint fill.
const TOOLBAR = cx(
  "rounded-icon-button text-toolbar-foreground hover:bg-fill hover:text-foreground focus-visible:text-foreground",
  "aria-expanded:bg-fill aria-expanded:text-foreground active:bg-fill-active svg:size-icon-md",
  "aria-pressed:bg-fill-subtle aria-pressed:text-foreground aria-pressed:hover:bg-fill-hover",
);

// A sidebar strip or foot icon: a row tall, filled while hovered, pressed or while its menu is open.
const STRIP = cx(
  "relative flex min-w-8 gap-1.5 text-strip-foreground transition-all motion-safe:active:scale-press",
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
   * `ghost`: a quiet icon in a card, row or composer; its tip shows at once. `toolbar`, `strip`, `chip`
   * (the strip's look, outlined and round-ended, for the foot's update pill) and `chip-tall` (the same,
   * standing up) take their tip timing from the provider around them (TitlebarTips, the sidebar).
   */
  look?: "ghost" | "toolbar" | "strip" | "chip" | "chip-tall" | "pill" | "round" | "toggle";
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
  const flat = look === "strip" || look === "chip" || look === "chip-tall" || look === "pill" || look === "round" || look === "toggle";
  const button = (
    <Button
      variant={flat ? null : (variant ?? "ghost")}
      size={flat ? null : (size ?? (ghost ? "icon-sm" : "icon-md"))}
      aria-label={tooltip}
      aria-pressed={pressed}
      className={cx(
        ghost && (variant ?? "ghost") === "ghost" && "aria-expanded:bg-fill",
        look === "toolbar" && TOOLBAR,
        flat && !["round", "pill", "toggle"].includes(look) && STRIP,
        // A round glass button on its own (New tab): 30px, control-fill with the glass edge [new-design].
        look === "round" && "flex size-7.5 items-center justify-center rounded-capsule bg-control text-foreground ring-1 ring-glass-stroke ring-inset hover:bg-fill-hover svg:size-icon-md motion-safe:active:scale-press",
        look === "strip" && "h-7.5 rounded-icon-button",
        // A button inside a glass pill (History, the toolbar): 32 by 26 [new-design].
        look === "pill" && "flex h-6.5 w-8 items-center justify-center rounded-icon-button text-foreground transition-all hover:bg-fill disabled:opacity-disabled svg:size-icon-md motion-safe:active:scale-press",
        // Context and Files in their pill: 32 by 26, dim at rest, white with a glow while on [new-design].
        look === "toggle" && "flex h-6.5 w-8 items-center justify-center rounded-capsule text-toggle-off transition-all hover:text-foreground aria-pressed:text-foreground aria-pressed:drop-shadow-toggle-glow disabled:opacity-disabled svg:size-icon-md",
        look === "chip" && "h-7.5 rounded-capsule border border-border px-2",
        look === "chip-tall" && "flex-col rounded-capsule border border-border py-2",
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
      <TooltipContent side={side}>
        {tooltip}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}
