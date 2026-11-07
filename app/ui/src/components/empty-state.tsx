import type { ComponentType, ReactNode } from "react";

import { cx } from "./cx";

const SHAPE = {
  line: "flex min-h-nav-row items-center gap-3 px-2",
  card: "flex items-center gap-3 px-4 py-3",
  centered: "flex flex-col items-center justify-center gap-1.5 py-8 text-center",
};

/** What a list, card or pane shows with nothing in it ("No sessions yet"). */
export function EmptyState({
  variant = "line",
  icon: Icon,
  title,
  detail,
  as: Tag = "p",
  className,
}: {
  /**
   * `line`: a muted line in a list. `card`: the same line as a card's only row, padded like a row.
   * `centered`: icon, title and line in the middle.
   */
  variant?: keyof typeof SHAPE;
  icon?: ComponentType<{ className?: string }>;
  title: ReactNode;
  /** A line under the title (centered only); the title then reads as a heading. */
  detail?: ReactNode;
  /** `li` inside a list; such a line is not announced, a list item can't be a status. */
  as?: "p" | "div" | "li";
  className?: string;
}) {
  return (
    <Tag
      data-slot="empty-state"
      role={Tag === "li" ? undefined : "status"}
      className={cx("text-sm text-quiet-foreground", SHAPE[variant], className)}
    >
      {Icon && <Icon className={cx("shrink-0", variant === "centered" ? "size-icon-lg" : "size-icon-md")} />}
      {variant === "centered" && detail ? (
        <>
          <span className="font-medium text-foreground">{title}</span>
          <span className="text-label">{detail}</span>
        </>
      ) : (
        title
      )}
    </Tag>
  );
}
