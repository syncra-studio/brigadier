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

const IRREGULAR: Record<string, string> = {
  begin: "began", bring: "brought", build: "built", buy: "bought", catch: "caught", choose: "chose", commit: "committed",
  cut: "cut", do: "did", draw: "drew", feed: "fed", find: "found", get: "got", give: "gave", go: "went", hit: "hit",
  hold: "held", keep: "kept", leave: "left", let: "let", lose: "lost", make: "made", meet: "met", pay: "paid", put: "put",
  quit: "quit", read: "read", rebuild: "rebuilt", redo: "redid", reread: "reread", rerun: "reran", reset: "reset",
  rewrite: "rewrote", run: "ran", say: "said", see: "saw", sell: "sold", send: "sent", set: "set", shut: "shut",
  sleep: "slept", spend: "spent", split: "split", submit: "submitted", take: "took", tell: "told", think: "thought",
  throw: "threw", understand: "understood", undo: "undid", wake: "woke", write: "wrote",
};
const PAST = new Set(Object.values(IRREGULAR));

/** A verb in the past: "List" is "Listed", "Stop" "Stopped", "Copy" "Copied", "Read" "Read". Already past, as it is. */
export function past(verb: string): string {
  const word = verb.toLowerCase();
  let done: string;
  if (IRREGULAR[word]) done = IRREGULAR[word];
  else if (word.endsWith("ed") || PAST.has(word) || !/^[a-z]+$/.test(word)) return verb;
  else if (word.endsWith("e")) done = `${word}d`;
  else if (/[^aeiou]y$/.test(word)) done = `${word.slice(0, -1)}ied`;
  // One short syllable ending vowel-consonant doubles it: "stop", "grep", "plan".
  else if (/^[^aeiou]{0,3}[aeiou][bdgklmnprt]$/.test(word)) done = `${word}${word.at(-1)}ed`;
  else done = `${word}ed`;
  return verb[0] === verb[0]!.toUpperCase() ? done.charAt(0).toUpperCase() + done.slice(1) : done;
}

/** What the agent said it does, as done and short: "List Brigadier sessions to find who holds the computer" is "Listed Brigadier sessions". */
export function said(text: string): string {
  const words = text.trim().replace(/\s+/g, " ").replace(/[.:]$/, "").split(" ");
  // Its why and what came next go ("to find …", "as requested", "and print …"), when what is left still says what.
  const cut = words.findIndex(
    (word, at) =>
      at >= 2 &&
      (/^(to|so|as|because|then)$/i.test(word) ||
        (word === "and" && !/^(the|its|their|a|an|all|each|every|any|some|[\d"'`])/i.test(words[at + 1] ?? "")) ||
        // A new clause after a comma: "List apps, reopen TextEdit" is "Listed apps".
        (words[at - 1]!.endsWith(",") && /^[a-z]+$/.test(word) && !/^(the|its|their|a|an|all|each|every|any|some|and|or)$/.test(word))),
  );
  const kept = (cut > 0 ? words.slice(0, cut) : words).join(" ").replace(/[,;]$/, "").split(" ");
  // Its verbs: the first, and each after a leading list of them ("Clear, click 128 × 37" is "Cleared, clicked 128 × 37").
  for (let at = 0; at < kept.length; at++) {
    const comma = kept[at]!.endsWith(",");
    kept[at] = comma ? `${past(kept[at]!.slice(0, -1))},` : past(kept[at]!);
    if (!comma) break;
  }
  return kept.join(" ");
}

const base = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
/** A command as the program it ran, and its subcommand when it has one: "brigadier computer", "git status", "curl". */
const program = (command: string): string => {
  const [first = "", second = ""] = command.trim().split(/\s+/);
  if (first === "cd" && command.includes("&&")) return program(command.slice(command.indexOf("&&") + 2));
  if (/^(for|while|until|if|case)$/.test(first)) return "a shell script";
  return /^[a-z][a-z-]*$/.test(second) ? `${base(first)} ${second}` : base(first);
};

/** One step as what it did: [the verb it is said with, what it acted on]; a verb alone is a whole clause. */
function done(item: Item): [string, string?] | null {
  if (item.kind === "fileChange") return ["Edited", item.changes.map((change) => base(change.path)).join("\u0000")];
  if (item.kind === "childAgent") return [said(item.title || "Run a subagent")];
  if (item.kind !== "tool") return null;
  if (item.description) return [said(item.description)];
  const input = item.input.trim().split("\n")[0]!.trim();
  switch (item.step ?? "other") {
    case "run":
      return ["Ran", program(input) || item.name];
    case "read":
      return ["Read", base(input || item.name)];
    case "edit":
      return ["Edited", base(input || item.name)];
    case "list":
      return [`Listed files in ${base(input) || "the project"}`];
    case "search":
      return ["Searched code"];
    case "web":
      return ["Searched the web"];
    case "agent":
      return [said(input || "Run a subagent")];
    case "skill":
      return ["Used", item.name || "a skill"];
    default:
      return ["Used", item.server ? connectorName(item.server) : item.name];
  }
}

/** "A", "A and B", "A, B and C". */
const joined = (parts: readonly string[]) => (parts.length < 3 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);

/**
 * A group's one line, the gallery's, saying what its steps did from their own words, never a count [D697, D755, D758]:
 * "Ran brigadier computer, listed Brigadier sessions and searched the web". Steps said with the same verb share a
 * clause ("Read lines.ts, words.ts"); every step is said, a long line ending in its row's ellipsis.
 * Thoughts say nothing; a group of only thoughts is "Thought".
 */
export function groupWords(steps: readonly Item[]): string {
  const clauses = new Map<string, string[]>();
  for (const step of steps) {
    const [verb, object] = done(step) ?? [];
    if (!verb) continue;
    const objects = clauses.get(verb) ?? [];
    for (const each of object?.split("\u0000") ?? []) if (each && !objects.includes(each)) objects.push(each);
    clauses.set(verb, objects);
  }
  if (!clauses.size) return "Thought";
  const parts = [...clauses].map(([verb, objects]) => (objects.length ? `${verb} ${objects.join(", ")}` : verb));
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
