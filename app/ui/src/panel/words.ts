/* The right panel's words, written from what Rust sends [D65]. */

import { plural } from "../../../shared/words";

export { plural };

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

/** "14:32", the watch's clock time. */
export const clock = (atMs: number) => new Date(atMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
