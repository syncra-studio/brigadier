import { cx } from "./cx";

/**
 * A scroll view's edge: what scrolls under it fades into the background. It lies over the view, never in
 * what scrolls, so an overscroll bounce moves the content under it and never the fade. `raised` reaches
 * the bottom fade over a floating button.
 */
export function ScrollFade({ edge, raised, className }: { edge: "top" | "bottom"; raised?: boolean; className?: string }) {
  return (
    <div
      aria-hidden
      data-slot="scroll-fade"
      data-raised={raised || undefined}
      className={cx("pointer-events-none absolute inset-x-0 z-10", edge === "top" ? "fade-top top-0" : "fade-bottom bottom-0", className)}
    />
  );
}
