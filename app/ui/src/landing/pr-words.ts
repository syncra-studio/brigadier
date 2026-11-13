import type { PrEvent, PrState, PullRequest } from "./pull-requests";

/** A PR's state as GitHub says it, wherever a PR shows [D202]: never Ready for one waiting on review. */
export const STATE_WORDS: Record<PrState, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };

const EVENT_WORDS: Record<PrEvent["kind"], string> = {
  opened: "opened",
  pushed: "pushed",
  checks_running: "checks running",
  checks_failed: "checks failed",
  checks_passed: "checks passed",
  changes_requested: "changes requested",
  approved: "approved",
  commented: "commented",
  merged: "merged",
  closed: "closed",
  force_pushed: "force-pushed",
  review_requested: "requested a review from",
  reopened: "reopened",
  ready: "marked it ready for review",
  draft: "marked it as a draft",
};

export const eventWords = (event: PrEvent): string => EVENT_WORDS[event.kind];

/** "20 s ago", "14 min ago", "3 h ago", "2 d ago". */
export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** "2m 13s", "31s". */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** "14:32". */
export const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Why it can't merge yet, in one line, from Rust's blockers; null when nothing stands in the way. */
export function blockerWords(pr: PullRequest): string | null {
  const blockers = pr.blockers;
  if (!blockers) return null;
  const { failedChecks: failed, changesBy } = blockers;
  const parts = [
    failed > 0 && (failed === 1 ? "1 check failed" : `${failed} checks failed`),
    changesBy.length > 0 && `${changesBy.join(" and ")} asked for changes`,
    blockers.conflicts && "it conflicts with its base",
  ].filter(Boolean);
  return parts.length > 0 ? `Can't merge yet: ${parts.join(" and ")}.` : null;
}

/** A read younger than the watch's quickest pace isn't asked again on open or focus [D207]. */
export const FRESH_MS = 30_000;
