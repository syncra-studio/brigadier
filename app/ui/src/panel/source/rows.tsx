import type { ReactNode } from "react";

import { cx } from "../../components/cx";
import { PullRequestMerged, PullRequestOpen } from "../../landing/icons";
import type { Pr } from "../types";
import { prWords, type Tone } from "../words";

/**
 * One row of the card, the old card's 28px row [D1198, D1206]: an icon, the title and what ends it. `onClick`
 * makes it a button with the row's hover.
 */
export function Line({ icon, end, onClick, children }: { icon?: ReactNode; end?: ReactNode; onClick?: () => void; children: ReactNode }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      {...(onClick && { type: "button" as const, onClick })}
      className={cx(
        "relative isolate flex min-h-7 w-full min-w-0 items-center gap-2 py-0.5 text-start text-label font-prose",
        onClick && "cursor-pointer before:absolute before:inset-y-0 before:-inset-x-2 before:-z-10 before:rounded-control hover:before:bg-muted focus-visible:focus-ring",
      )}
    >
      {icon && <span aria-hidden className="flex min-w-icon-md shrink-0 items-center justify-center text-muted-foreground svg:size-icon-md">{icon}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{children}</span>
      </span>
      {end && <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">{end}</span>}
    </Tag>
  );
}

/** A PR's icon, word and colour: prWords' words, the old card's colours (yellow running, purple merged) [D1198]. */
const PR_TINT: Record<Tone, string> = { quiet: "text-pr-yellow", good: "text-success", warn: "text-pr-yellow", bad: "text-destructive" };
export function PrLine({ pr, onClick }: { pr: Pr; onClick?: () => void }) {
  const { word, tone } = prWords(pr);
  const tint = pr.state === "merged" ? "text-pr-purple" : pr.state === "open" && pr.health === "unknown" ? "text-muted-foreground" : PR_TINT[tone];
  return (
    <Line onClick={onClick} icon={<span className={cx("flex", tint)}>{pr.state === "merged" ? <PullRequestMerged /> : <PullRequestOpen />}</span>} end={<span className={tint}>{word}</span>}>
      <span className="text-muted-foreground">#{pr.number}</span> {pr.title}
    </Line>
  );
}

/** "+62 −8": lines added and removed, each only when there are some. */
export function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      {added > 0 && <span className="text-success">+{added}</span>} {removed > 0 && <span className="text-destructive">−{removed}</span>}
    </span>
  );
}
