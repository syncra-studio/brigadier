import { cx } from "./cx";

/**
 * A scroll view's edge, its bottom by default: what scrolls under it fades into the surface it sits on, the main area's
 * unless `surface` says the sidebar's. It lies over the view, never in what scrolls, so an overscroll bounce moves the
 * content under it and never the fade. `raised` reaches the bottom fade over a floating button. `whileMore` shows it only
 * while there is more to scroll that way: the view is `scroll-fade-source` inside a `scroll-fade-scope` holding the fade
 * [D282 D284].
 */
export function ScrollFade({ side = "bottom", surface, whileMore, raised, className }: {
  side?: "top" | "bottom";
  surface?: "sidebar";
  whileMore?: boolean;
  raised?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      data-slot="scroll-fade"
      data-raised={raised || undefined}
      data-surface={surface}
      data-while-more={whileMore || undefined}
      className={cx("pointer-events-none absolute inset-x-0 z-10", side === "top" ? "top-0 fade-top" : "bottom-0 fade-bottom", className)}
    />
  );
}
