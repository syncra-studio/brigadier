import { cx } from "./cx";

const TONES = { ready: "bg-success", needs: "bg-warning", off: "bg-muted-foreground" } as const;

/** A small round dot before a line: a state's `tone` (ready, needing a step, or off), or any `color` class. */
export function StateDot({ tone = "off", color }: { tone?: keyof typeof TONES; color?: string }) {
  return <span aria-hidden className={cx("size-1.5 shrink-0 rounded-capsule", color ?? TONES[tone])} />;
}
