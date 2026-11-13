// Words rows show, written from what Rust sent: formatting only. And one clock for every live time on screen.
import { useSyncExternalStore } from "react";

import type { StepKind, Turn, Work } from "./item";

const STEPS: Record<StepKind, [string, string]> = {
  edit: ["edited a file", "edited {n} files"],
  read: ["read a file", "read {n} files"],
  list: ["listed files", "listed files {n} times"],
  search: ["searched once", "searched {n} times"],
  run: ["ran a command", "ran {n} commands"],
  web: ["searched the web", "searched the web {n} times"],
  agent: ["ran a subagent", "ran {n} subagents"],
  skill: ["used a skill", "used {n} skills"],
  other: ["used a tool", "used {n} tools"],
};
/** Kinds in the order a group names them; its icon is the first one it holds. */
export const ORDER = Object.keys(STEPS) as StepKind[];

/** An MCP server as the user knows it, as the old app's: "atlassian" is "Atlassian". */
export function connectorName(server: string): string {
  const words = server.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "an integration";
}

/** "Edited 3 files, ran 2 commands, used Atlassian 2 times": a group's counts, in a fixed kind order, only the first part capitalised. */
export function groupWords(steps: readonly { kind: StepKind; n: number; server?: string | null }[]): string {
  const text = [...steps]
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
    .map(({ kind, n, server }) =>
      server ? `used ${connectorName(server)}${n === 1 ? "" : ` ${n.toLocaleString()} times`}` : n === 1 ? STEPS[kind][0] : STEPS[kind][1].replace("{n}", n.toLocaleString()),
    )
    .join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
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
  // Answered, it still waits on its subagents, counting on [D114].
  if (turn.helpers) return `Working for ${duration(ms)} · ${turn.helpers} ${turn.helpers === 1 ? "subagent" : "subagents"} running`;
  if (turn.held) return `Working for ${duration(ms)}`;
  if (turn.status === "running" && ms < 1000) return "Working";
  // The actions turned down in it, beside the time (D487).
  const denied = turn.denied ?? work?.denied;
  return `${ENDED[turn.status]} ${duration(ms)}${denied ? ` · ${denied} denied` : ""}`;
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
