import type { PrEvent, PrState, PullRequest } from "./pull-requests";

/** A pull request's word and its colour family, the old app's pullRequestWords [D48]. */
export type PrLook = { word: string; tone: Tone };
export type Tone = "good" | "failed" | "waiting" | "merged" | "quiet";

/** Terminal states win, then failing checks (a draft no longer hides them [D1017]), draft, running checks and readiness. */
export function prLook(pr: PullRequest): PrLook {
  if (pr.state === "merged") return { word: "Merged", tone: "merged" };
  if (pr.state === "closed") return { word: "Closed", tone: "quiet" };
  if (pr.ci === "failing") return { word: "Checks failed", tone: "failed" };
  if (pr.state === "draft") return { word: "Draft", tone: "quiet" };
  if (pr.ci === "pending") return { word: "Checks running", tone: "waiting" };
  if (pr.review === "changes_requested") return { word: "Changes requested", tone: "waiting" };
  if (pr.review === "approved" && pr.mergeable) return { word: "Ready", tone: "good" };
  return { word: "Review needed", tone: "waiting" };
}

export const TONES: Record<Tone, string> = {
  good: "text-success",
  failed: "text-destructive",
  waiting: "text-pr-yellow",
  merged: "text-pr-purple",
  quiet: "text-muted-foreground",
};

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

/** Why it can't merge yet, in one line; null when nothing stands in the way. */
export function blockers(pr: PullRequest): string | null {
  if (pr.state !== "open") return null;
  const failed = pr.checks.filter((check) => check.state === "failed").length;
  const parts = [
    failed > 0 && (failed === 1 ? "1 check failed" : `${failed} checks failed`),
    pr.review === "changes_requested" && `${pr.changesBy.length > 0 ? pr.changesBy.join(" and ") : "a reviewer"} asked for changes`,
    !pr.mergeable && "it conflicts with its base",
  ].filter(Boolean);
  return parts.length > 0 ? `Can't merge yet: ${parts.join(" and ")}.` : null;
}
