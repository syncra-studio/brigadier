import { Badge } from "../components/badge";

/** One PR's state, as the sidebar knows it. */
export type PrMark = "checks_failed" | "changes_asked" | "ready" | "merged" | "running" | "open" | "draft" | "closed";

/**
 * A session's PR chip as Rust computes it from every PR of the session (2.28): the one that needs you wins, and
 * Merged only until the session is seen or new work lands [D1011, D1018]. PROPOSED contract, unwired.
 */
export type PrChipState = { chip: "checks_failed" | "changes_asked" | "ready" | "merged"; prs: { number: number; mark: PrMark }[] };

const WORDS: Record<PrMark, string> = {
  checks_failed: "Checks failed",
  changes_asked: "Changes asked",
  ready: "Ready",
  merged: "Merged",
  running: "Checks running",
  open: "Open",
  draft: "Draft",
  closed: "Closed",
};

const LOOK = {
  checks_failed: "destructive-soft",
  changes_asked: "warning",
  ready: "success",
  merged: "purple",
} as const;

/** The chip on a sidebar row, before its mark: one word for the PR that needs you most. */
export function PrChip({ pr }: { pr: PrChipState }) {
  return (
    <Badge data-slot="row-pr" variant={LOOK[pr.chip]} className="me-0.5">
      {WORDS[pr.chip]}
    </Badge>
  );
}

/** Every PR in one line, for the row's hover card: "#14 Checks failed · #12 Merged". */
export const prList = (pr: PrChipState): string => pr.prs.map((each) => `#${each.number} ${WORDS[each.mark]}`).join(" · ");
