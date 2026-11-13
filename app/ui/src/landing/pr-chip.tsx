/** One PR's state, as the sidebar knows it. */
export type PrMark = "checks_failed" | "conflict" | "changes_asked" | "ready" | "merged" | "running" | "open" | "draft" | "closed";

/**
 * A session's PRs as Rust computes it from every PR of the session (2.28): the one that needs you first, and
 * Merged only until the session is seen or new work lands [D1011, D1018]. Conflict: a PR that conflicts with its base,
 * as the host says [D1231].
 */
export type PrChipState = { chip: "checks_failed" | "conflict" | "changes_asked" | "ready" | "merged"; prs: { number: number; mark: PrMark }[] };

const WORDS: Record<PrMark, string> = {
  checks_failed: "Checks failed",
  conflict: "Conflict",
  changes_asked: "Changes asked",
  ready: "Ready",
  merged: "Merged",
  running: "Checks running",
  open: "Open",
  draft: "Draft",
  closed: "Closed",
};

/** Every PR in one line, for the row's hover card: "#14 Checks failed · #12 Merged". */
export const prList = (pr: PrChipState): string => pr.prs.map((each) => `#${each.number} ${WORDS[each.mark]}`).join(" · ");
