// Words rows show, written from what Rust sent: formatting only. And one clock for every live time on screen.
import { useSyncExternalStore } from "react";

import type { StepKind, Turn, Work } from "./item";

// The work-log words, counted: "Ran 2 commands" [D752].
const STEPS: Record<StepKind, [string, string]> = {
  edit: ["Changed # file", "Changed # files"],
  read: ["Read # file", "Read # files"],
  list: ["Listed files # time", "Listed files # times"],
  search: ["Searched code # time", "Searched code # times"],
  run: ["Ran # command", "Ran # commands"],
  web: ["Searched the web # time", "Searched the web # times"],
  agent: ["Ran # subagent", "Ran # subagents"],
  skill: ["Used # skill", "Used # skills"],
  other: ["Used # tool", "Used # tools"],
};
/** Kinds by the icon a group takes: its first one held. */
export const ORDER = Object.keys(STEPS) as StepKind[];

/** An MCP server as the user knows it, as the old app's: "atlassian" is "Atlassian". */
export function connectorName(server: string): string {
  const words = server.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "an integration";
}

const counted = (kind: StepKind, n: number) => STEPS[kind][n === 1 ? 0 : 1].replace("#", String(n));
/** "A", "A and B", "A, B, and C". */
const joined = (parts: readonly string[]) => (parts.length < 3 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`);
/** Commands and edits name first, tools last. */
const rank = (kind: StepKind) => (kind === "run" || kind === "edit" ? 0 : kind === "other" ? 2 : 1);

/**
 * A group's one line: "Used Atlassian, ran 2 commands, and read 1 file". MCP servers first,
 * then the two kinds that matter most in the order they came, the rest "performed 3 other actions"; thoughts
 * aren't counted, and a group of only thoughts is "Thought (×3)".
 */
export function groupWords(steps: readonly { kind: StepKind; n: number; server?: string | null }[], thoughts = 0): string {
  const servers = [...new Set(steps.flatMap(({ server }) => (server ? [connectorName(server)] : [])))];
  const kinds = steps.filter(({ server }) => !server);
  if (!servers.length && !kinds.length) return thoughts > 1 ? `Thought (×${thoughts})` : "Thought";
  const top = kinds
    .map((step, at) => ({ ...step, at }))
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.at - b.at)
    .slice(0, 2)
    .sort((a, b) => a.at - b.at);
  const rest = kinds.reduce((sum, { n }) => sum + n, 0) - top.reduce((sum, { n }) => sum + n, 0);
  const parts = [...(servers.length ? [`Used ${joined(servers)}`] : []), ...top.map(({ kind, n }) => counted(kind, n))];
  if (rest > 0) parts.push(`Performed ${rest} other action${rest === 1 ? "" : "s"}`);
  return joined(parts.map((part, at) => (at === 0 ? part : part.charAt(0).toLowerCase() + part.slice(1))));
}

const ENDED: Record<Turn["status"], string> = {
  running: "Working for",
  done: "Worked for",
  // A failure is said once, by its row at the turn's end [D54]; your Stop by its own line under the turn [D2099].
  failed: "Worked for",
  cancelled: "Worked for",
};

/** "Working for 12s" while the turn runs (from `now`), "Worked for 3m 4s" once it's done. */
export function workWords(turn: Turn, work: Work | undefined, now: number): string {
  // Live, one clock from the turn's start that never resets [D128]; ended, like Rust's `Work.ms`, its waits on the user don't count.
  const live = turn.status === "running" || turn.held;
  const ms = work?.ms ?? (live ? now - turn.startedAt : (turn.endedAt ?? now) - turn.startedAt - (turn.waitedMs ?? 0));
  // Answered, it still waits on what it started, counting on [D114]; WorkHeader says on what.
  if (turn.held) return `Working for ${duration(ms)}`;
  if (turn.status === "running" && ms < 1000) return "Working";
  // The actions turned down in it, beside the time (D487).
  const denied = turn.denied ?? work?.denied;
  return `${ENDED[turn.status]} ${duration(ms)}${denied ? ` · ${denied} denied` : ""}${turn.unchecked ? " · safety check unavailable" : ""}`;
}

/** A clock time, "09:39". */
export const hhmm = (ms: number) => {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

/** 12s, 3m 4s, 1h 5m. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

let second = Date.now();
const ticking = new Set<() => void>();
let timer = 0;
function subscribe(listener: () => void) {
  ticking.add(listener);
  if (ticking.size === 1) {
    second = Date.now();
    timer = window.setInterval(() => {
      second = Date.now();
      for (const each of ticking) each();
    }, 1000);
  }
  return () => {
    ticking.delete(listener);
    if (ticking.size === 0) window.clearInterval(timer);
  };
}
const still = () => () => {};
const read = () => second;

/** The time, to the second; it ticks only while `live`, on one timer shared by every live time. */
export function useSecond(live: boolean): number {
  return useSyncExternalStore(live ? subscribe : still, read);
}
