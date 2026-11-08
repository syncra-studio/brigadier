import { cx } from "./cx";

/**
 * An error the daemon (or validation) reported, shown where it happened. Nothing when there is none.
 * `size="sm"` matches WorkingLine, for a run's status line.
 */
export function ErrorLine({ error, size = "xs", className }: { error: string | null | undefined; size?: "xs" | "sm"; className?: string }) {
  if (!error) return null;
  return (
    <p role="alert" className={cx(size === "sm" ? "text-sm leading-5.25" : "text-xs", "whitespace-pre-wrap text-destructive", className)}>
      {error}
    </p>
  );
}
