import { cx } from "./cx";

/** An error the daemon (or validation) reported, shown where it happened. Nothing when there is none. */
export function ErrorLine({ error, className }: { error: string | null | undefined; className?: string }) {
  if (!error) return null;
  return (
    <p role="alert" className={cx("text-xs whitespace-pre-wrap text-destructive", className)}>
      {error}
    </p>
  );
}
