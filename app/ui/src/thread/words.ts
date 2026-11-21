// Words rows show, written from what Rust sent: formatting only. And one clock for every live time on screen.
import { useSyncExternalStore } from "react";

import type { Item, StepKind, Turn, Work } from "./item";

/** Kinds by the icon a group takes: its first one held. */
export const ORDER: StepKind[] = ["edit", "read", "list", "search", "run", "web", "agent", "skill", "other"];

/** An MCP server as the user knows it, as the old app's: "atlassian" is "Atlassian". */
export function connectorName(server: string): string {
  const words = server.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "an integration";
}

/**
 * A group's one line, short words for what kinds of steps it holds, in order [D116]: "Read files, ran
 * commands", "Edited a file, searched, listed files". Rust tells each step's kind, shell commands by what they do, so
 * only true commands say "ran". Thoughts say nothing; a group of only thoughts is "Thought".
 */
export function groupWords(steps: readonly Item[]): string {
  const used: string[] = [];
  const files = new Set<string>();
  const n: Partial<Record<StepKind, number>> = {};
  for (const step of steps) {
    const kind = step.kind === "fileChange" ? "edit" : step.kind === "childAgent" ? "agent" : step.kind === "tool" ? (step.step ?? "other") : null;
    if (!kind) continue;
    // An MCP server's or a skill's calls say its name: "Used Linear", "Used code-review".
    const name = step.kind !== "tool" ? null : kind === "skill" ? step.name || "a skill" : kind === "other" && step.server ? connectorName(step.server) : null;
    if (name) {
      if (!used.includes(name)) used.push(name);
      continue;
    }
    n[kind] = (n[kind] ?? 0) + 1;
    if (step.kind === "fileChange") for (const change of step.changes) files.add(change.path);
    else if (kind === "edit" && step.kind === "tool") files.add(step.input);
  }
  const one = (count: number | undefined, a: string, many: string) => (count === 1 ? a : many);
  const parts = [
    used.length && `used ${used.length < 3 ? used.join(" and ") : `${used.slice(0, -1).join(", ")} and ${used.at(-1)}`}`,
    n.edit && `edited ${one(files.size || n.edit, "a file", "files")}`,
    n.read && "read files",
    n.search && "searched",
    n.list && "listed files",
    n.run && `ran ${one(n.run, "a command", "commands")}`,
    n.web && "searched the web",
    n.agent && `ran ${one(n.agent, "a subagent", "subagents")}`,
    n.other && `called ${one(n.other, "a tool", "tools")}`,
  ].filter(Boolean);
  const line = parts.join(", ") || "thought";
  return line.charAt(0).toUpperCase() + line.slice(1);
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
