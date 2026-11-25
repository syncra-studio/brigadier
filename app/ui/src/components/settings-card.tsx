import type { ComponentProps, ReactNode } from "react";

import { cx } from "./cx";

/**
 * A Settings card: its fill, edge and corners, its rows split by hairlines 16 in. Each row pads itself 16
 * in; `inset` pads the card instead, for content that isn't rows of its own. `split={false}` leaves the
 * hairlines out.
 */
export function SettingsCard({
  inset = false,
  split = true,
  className,
  ...props
}: ComponentProps<"div"> & { inset?: boolean; split?: boolean }) {
  return (
    <div
      data-slot="settings-card"
      {...props}
      className={cx(
        "flex flex-col overflow-hidden rounded-settings border border-divider bg-card",
        inset && "px-4",
        split && "settings-rows",
        split && inset && "settings-rows-flush",
        className,
      )}
    />
  );
}

/** A row's words: its title over a grey line. `truncate` keeps each to one line. */
export function RowText({
  title,
  line,
  truncate = false,
  className,
}: {
  title: ReactNode;
  line?: ReactNode;
  truncate?: boolean;
  className?: string;
}) {
  return (
    <span className={cx("flex min-w-0 flex-1 flex-col gap-1", className)}>
      <span className={cx("text-label font-medium", truncate && "truncate")}>{title}</span>
      {line && <span className={cx("text-xs text-quiet-foreground", truncate && "truncate")}>{line}</span>}
    </span>
  );
}
