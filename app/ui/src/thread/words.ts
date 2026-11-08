// Words rows show, written from what Rust sent: formatting only. And one clock for every live time on screen.
import { useSyncExternalStore } from "react";

import type { StepKind, Turn, Work } from "./item";

const STEPS: Record<StepKind, [string, string]> = {
  edit: ["edited a file", "edited {n} files"],
  read: ["read a file", "read {n} files"],
  search: ["searched once", "searched {n} times"],
  run: ["ran a command", "ran {n} commands"],
  web: ["searched the web", "searched the web {n} times"],
  agent: ["ran a subagent", "ran {n} subagents"],
  other: ["used a tool", "used {n} tools"],
};
/** Kinds in the order a group names them; its icon is the first one it holds. */
export const ORDER = Object.keys(STEPS) as StepKind[];

/** "Edited 3 files, ran 2 commands": a group's counts, in a fixed kind order, only the first part capitalised. */
export function groupWords(steps: readonly { kind: StepKind; n: number }[]): string {
  const text = [...steps]
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
    .map(({ kind, n }) => (n === 1 ? STEPS[kind][0] : STEPS[kind][1].replace("{n}", n.toLocaleString())))
    .join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const ENDED: Record<Turn["status"], string> = {
  running: "Working for",
  done: "Worked for",
  failed: "Stopped after",
  cancelled: "You stopped after",
};

/** "Working for 12s" while the turn runs (from `now`), "Worked for 3m 4s" once it's done. */
export function workWords(turn: Turn, work: Work | undefined, now: number): string {
  // Like Rust's `Work.ms`, the turn's finished waits on the user don't count.
  const ms = work?.ms ?? (turn.endedAt ?? now) - turn.startedAt - (turn.waitedMs ?? 0);
  if (turn.status === "running" && ms < 1000) return "Working";
  return `${ENDED[turn.status]} ${duration(ms)}`;
}

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
