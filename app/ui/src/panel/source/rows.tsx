import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { cx } from "../../components/cx";
import { InfoTip } from "../../components/thread/tip";
import { Warning } from "../../icons";
import { PullRequestClosed, PullRequestDraft, PullRequestMerged, PullRequestOpen } from "../../landing/icons";

/** A card row, 28 tall at radius 6, and its hover wash [D139]. */
export const ROW = "flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-start text-label";
export const ROW_HOVER = "hover:bg-summary-row-hover focus-visible:focus-ring";

/**
 * One row of the card, 28 tall [D139]: an icon in a 20 wide slot, the words and what ends them.
 * `onClick` makes it a button with the row's hover. `action`: what shows over its end on hover (a Stop, a "…"),
 * the row keeping its hover meanwhile.
 */
export function Line({ icon, end, onClick, action, title, className, children }: { icon?: ReactNode; end?: ReactNode; onClick?: () => void; action?: ReactNode; title?: string; className?: string; children: ReactNode }) {
  const Tag = onClick ? "button" : "div";
  const row = (
    <Tag
      {...(onClick && { type: "button" as const, onClick })}
      title={title}
      className={cx(
        ROW,
        onClick && cx("cursor-pointer", ROW_HOVER),
        Boolean(action) && "group-hover/row:bg-summary-row-hover group-has-data-popup-open/row:bg-summary-row-hover",
        className,
      )}
    >
      {icon && <span aria-hidden className="flex min-w-5 shrink-0 items-center justify-center svg:size-4">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {end && (
        <span className={cx("flex shrink-0 items-center gap-1.5 text-label text-muted-foreground tabular-nums", Boolean(action) && "group-hover/row:invisible group-has-focus-visible/row:invisible group-has-data-popup-open/row:invisible")}>
          {end}
        </span>
      )}
    </Tag>
  );
  if (!action) return row;
  return (
    <div className="group/row relative min-w-0">
      {row}
      <span
        data-slot="summary-row-action"
        className={cx(
          "row-backing row-backing-hover pointer-events-none absolute inset-y-0 end-0 flex items-center rounded-e-sm ps-4 pe-1 opacity-0 transition-opacity",
          "group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-has-focus-visible/row:pointer-events-auto group-has-focus-visible/row:opacity-100 has-data-popup-open:pointer-events-auto has-data-popup-open:opacity-100",
        )}
      >
        {action}
      </span>
    </div>
  );
}

/** The list: the first 5, then "Show N more", 5 at a time [D139]. */
export function Rows<T>({ items, children }: { items: readonly T[]; children: (item: T, index: number) => ReactNode }) {
  const [shown, setShown] = useState(5);
  return (
    <>
      {items.slice(0, shown).map(children)}
      {items.length > shown && (
        <Line onClick={() => setShown(shown + 5)} className="text-muted-foreground">
          Show {items.length - shown} more
        </Line>
      )}
    </>
  );
}

/** A PR's state as GitHub says it, in its icon, word and colour: Open, Draft, Merged, Closed [D202]. */
export const PR_LOOK = {
  open: { Icon: PullRequestOpen, tint: "text-success" },
  draft: { Icon: PullRequestDraft, tint: "text-muted-foreground" },
  merged: { Icon: PullRequestMerged, tint: "text-pr-purple" },
  closed: { Icon: PullRequestClosed, tint: "text-destructive" },
};
/** "+62 −8": lines added and removed, each only when there are some. */
export function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      {added > 0 && <span className="text-success">+{added}</span>} {removed > 0 && <span className="text-destructive">−{removed}</span>}
    </span>
  );
}

/**
 * The card's one note line (main moved, waiting, merged on this machine, the checkout's truth): one line at most,
 * ending in an ellipsis and the kit's InfoTip when it doesn't fit [D1198]. `warn`: the user has something to do.
 */
export function Note({ text, warn = false }: { text: string; warn?: boolean }) {
  const words = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const element = words.current;
    if (element) setCut(element.scrollWidth > element.clientWidth);
  }, [text]);
  return (
    <p className={cx("flex min-w-0 items-center gap-1 pb-1 text-xs", warn ? "text-warning" : "text-muted-foreground")}>
      {warn && <Warning className="size-icon-xs shrink-0" />}
      <span ref={words} className="min-w-0 truncate">
        {text}
      </span>
      {cut && <InfoTip text={text} />}
    </p>
  );
}
