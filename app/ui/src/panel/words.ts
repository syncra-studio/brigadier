import type { Pr } from "./types";

/* The right panel's words, written from what Rust sends [D65]. */

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** "5 minutes ago", "2 hours ago", "3 days ago" (the old BranchPicker's). */
export function ago(atMs: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - atMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${plural(days, "day")} ago` : days < 365 ? `${plural(Math.floor(days / 30), "month")} ago` : `${plural(Math.floor(days / 365), "year")} ago`;
}

export type Tone = "quiet" | "good" | "warn" | "bad";

/** A PR's state word and its tone, as its row says it. */
export function prWords(pr: Pr): { word: string; tone: Tone } {
  if (pr.state === "merged") return { word: "Merged", tone: "quiet" };
  if (pr.state === "closed") return { word: "Closed", tone: "quiet" };
  switch (pr.health) {
    case "failed":
      return { word: pr.failed ? `${plural(pr.failed, "check")} failed` : "Checks failed", tone: "bad" };
    case "conflicts":
      return { word: "Conflict", tone: "warn" };
    case "changes":
      return { word: "Changes asked", tone: "warn" };
    case "running":
      return { word: "Checks running", tone: "quiet" };
    case "ready":
      return { word: "Ready", tone: "good" };
    case "cancelled":
      return { word: "Checks cancelled", tone: "warn" };
    case "unknown":
      return { word: "Check state unknown", tone: "quiet" };
  }
}

/** "14:32", the watch's clock time. */
export const clock = (atMs: number) => new Date(atMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
