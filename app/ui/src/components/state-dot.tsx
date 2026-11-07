import { cx } from "./cx";

const TONES = { ready: "bg-success", needs: "bg-warning", off: "bg-muted-foreground" } as const;

/**
 * A small round dot before a line: a state's `tone` (ready, needing a step, or off), or any `color`
 * class. `unread` is the old sidebar rows' larger blue dot for a new reply, announced by its `label`.
 */
export function StateDot({
  tone = "off",
  color,
  label = "New reply",
}: {
  tone?: keyof typeof TONES | "unread";
  color?: string;
  label?: string;
}) {
  if (tone === "unread") return <span role="img" aria-label={label} className="size-2 shrink-0 rounded-capsule bg-link" />;
  return <span aria-hidden className={cx("size-1.5 shrink-0 rounded-capsule", color ?? TONES[tone])} />;
}
