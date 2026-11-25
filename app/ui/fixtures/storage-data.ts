// Mockup only: what Rust would measure for Settings › Storage, faked in GB, and a count that arrives kind by kind.
import { useEffect, useState } from "react";

import { showToast } from "../src/components/toast";

export type Kind = "worktrees" | "build" | "temp" | "history" | "browser";
type Sizes = Record<Exclude<Kind, "browser">, number>;
/** A chat's own files, or one of its workers'. */
export type Holder = { id: string; title: string; sizes: Sizes; archived: boolean; worker: boolean; working?: boolean; unmerged?: boolean };
export type Chat = Holder & { project: string; workers: Holder[]; /** Chats it stands for, past the listed ones. */ many?: number };

const sizes = (worktrees: number, build: number, temp: number, history: number): Sizes => ({ worktrees, build, temp, history });
const worker = (id: string, title: string, archived: boolean, own: Sizes, state: Pick<Holder, "working" | "unmerged"> = {}): Holder => ({ id, title, sizes: own, archived, worker: true, ...state });

const CHATS: Chat[] = [
  {
    id: "export", title: "Ship the export dialog", project: "atlas", archived: false, worker: false, sizes: sizes(0.6, 3.1, 0.2, 0.4),
    workers: [
      worker("w1", "Draw the PDF pages", false, sizes(0.5, 4.2, 0.3, 0.1)),
      worker("w2", "Check the CSV columns", false, sizes(0.5, 3.8, 0.1, 0.1)),
      worker("w3", "Review the export", false, sizes(0.5, 2.9, 0.1, 0.1), { working: true }),
    ],
  },
  {
    id: "search", title: "Move search to SQLite", project: "atlas", archived: true, worker: false, sizes: sizes(0.6, 0, 0.1, 0.3),
    workers: [
      worker("w4", "Rebuild the index", true, sizes(0.5, 3.6, 0.2, 0.1)),
      worker("w5", "Compare the results", true, sizes(0.5, 3.3, 0.4, 0.1), { unmerged: true }),
    ],
  },
  {
    id: "signin", title: "Sign-in redesign", project: "lantern", archived: false, worker: false, sizes: sizes(0.4, 0, 0, 0.2),
    workers: [
      worker("w6", "Add passkeys", false, sizes(0.4, 2.6, 0.1, 0.1), { unmerged: true }),
      worker("w7", "Sign-in card mockup", false, sizes(0.4, 1.1, 0.6, 0.1)),
    ],
  },
  { id: "flaky", title: "Flaky checkout tests", project: "lantern", archived: true, worker: false, sizes: sizes(0.4, 0, 1.4, 0.2), workers: [] },
  { id: "invoices", title: "Invoice emails in German", project: "atlas", archived: false, worker: false, sizes: sizes(0.3, 0.9, 0, 0.1), workers: [] },
];
const REST: Chat[] = [
  { id: "rest-live", title: "", project: "", archived: false, worker: true, many: 26, sizes: sizes(3.1, 2.2, 0.9, 1.6), workers: [] },
  { id: "rest-archived", title: "", project: "", archived: true, worker: true, many: 61, sizes: sizes(1.2, 0.8, 1.9, 2.2), workers: [] },
];
const BROWSER = 1.3;
/** What Brigadier uses and what is free, together. */
const DISK = 324.7;
export const MORE = REST.reduce((sum, chat) => sum + (chat.many ?? 0), 0);

export const KINDS: { kind: Kind; label: string; line: string; fill: string }[] = [
  { kind: "build", label: "Build files", line: "What builds and installs made, like target and node_modules", fill: "bg-tile-sky" },
  { kind: "worktrees", label: "Worktrees", line: "Each session's and worker's own copy of the code", fill: "bg-tile-violet" },
  { kind: "temp", label: "Temp files", line: "What agents wrote outside the code while they worked", fill: "bg-tile-sunflower" },
  { kind: "history", label: "Chat history", line: "Every message, tool call and attachment", fill: "bg-tile-mint" },
  { kind: "browser", label: "Browser data", line: "Cookies, site data and cache of Brigadier's browser", fill: "bg-tile-coral" },
];
export const PER_CHAT: readonly Exclude<Kind, "browser">[] = ["build", "worktrees", "temp", "history"];

/** The two things Free up space takes: live chats' finished workers' build files, and archived chats' leftovers. */
export type Group = "build" | "left";
export const GROUPS: { group: Group; label: string; line: string }[] = [
  { group: "build", label: "Finished workers' build files", line: "The next build makes them again. Their code stays." },
  { group: "left", label: "Leftovers of archived chats", line: "Build files, temp files, and worktrees with nothing unmerged. Unarchive makes the worktree again." },
];

function goesWith(holder: Holder, kind: Kind): Group | null {
  if (holder.working || kind === "browser" || kind === "history") return null;
  if (holder.archived) return kind === "worktrees" && holder.unmerged ? null : "left";
  return holder.worker && kind === "build" ? "build" : null;
}
const holdersOf = (chat: Chat): Holder[] => [chat, ...chat.workers];
export const gb = (size: number) => (size >= 0.95 ? `${size.toFixed(1)} GB` : size < 0.05 ? "0 MB" : `${Math.round(size * 10) * 100} MB`);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export type Storage = ReturnType<typeof useStorage>;

/** `?state=counting` holds the count part way; `?state=freed` starts with everything freed. */
export function useStorage() {
  const asked = new URLSearchParams(location.search).get("state");
  const [counted, setCounted] = useState(0);
  const [freed, setFreed] = useState<ReadonlySet<string>>(() => new Set(asked === "freed" ? GROUPS.flatMap(({ group }) => PER_CHAT.map((kind) => `${group}:${kind}`)) : []));
  const [freeing, setFreeing] = useState<{ done: number; total: number } | null>(null);
  const last = asked === "counting" ? 2 : KINDS.length;
  useEffect(() => {
    if (counted >= last) return;
    const timer = setTimeout(() => setCounted(counted + 1), 550);
    return () => clearTimeout(timer);
  }, [counted, last]);

  const isFreed = (holder: Holder, kind: Kind) => {
    const group = goesWith(holder, kind);
    return group !== null && freed.has(`${group}:${kind}`);
  };
  const sizeOf = (holder: Holder, kind: Kind) => (kind === "browser" || isFreed(holder, kind) ? 0 : holder.sizes[kind]);
  const chatSize = (chat: Chat, kind?: Kind) => sum(holdersOf(chat).flatMap((holder) => (kind ? [kind] : PER_CHAT).map((each) => sizeOf(holder, each))));
  const holderSize = (holder: Holder) => sum(PER_CHAT.map((kind) => sizeOf(holder, kind)));
  const everyone = [...CHATS, ...REST].flatMap(holdersOf);
  const kindSize = (kind: Kind) => (kind === "browser" ? BROWSER : sum(everyone.map((holder) => sizeOf(holder, kind))));
  const ready = (kind: Kind) => KINDS.findIndex((each) => each.kind === kind) < counted;

  /** What Free up space would take now, of `group` and `kind` when given. */
  const freeable = (group?: Group, kind?: Kind) =>
    sum(everyone.flatMap((holder) => (kind ? [kind] : PER_CHAT).map((each) => (goesWith(holder, each) !== null && (!group || goesWith(holder, each) === group) ? sizeOf(holder, each) : 0))));
  /** What it takes of one chat, or of each of its holders. */
  const freeableOf = (holder: Holder, group?: Group) => sum(PER_CHAT.map((kind) => (goesWith(holder, kind) !== null && (!group || goesWith(holder, kind) === group) ? sizeOf(holder, kind) : 0)));

  const free = (groups: readonly Group[], kinds: readonly Kind[] = PER_CHAT) => {
    const size = sum(groups.flatMap((group) => kinds.map((kind) => freeable(group, kind))));
    let done = 0;
    setFreeing({ done, total: size });
    const tick = setInterval(() => {
      done += 1;
      if (done < 8) return setFreeing({ done: (size * done) / 8, total: size });
      clearInterval(tick);
      setFreed((now) => new Set([...now, ...groups.flatMap((group) => kinds.map((kind) => `${group}:${kind}`))]));
      setFreeing(null);
      showToast(`Freed ${gb(size)}`);
    }, 220);
  };

  return {
    counting: counted < KINDS.length,
    ready,
    kindSize,
    total: sum(KINDS.slice(0, counted).map(({ kind }) => kindSize(kind))),
    chats: [...CHATS].sort((a, b) => chatSize(b) - chatSize(a)),
    rest: sum(REST.map((chat) => chatSize(chat))),
    all: [...CHATS, ...REST],
    chatSize,
    holderSize,
    sizeOf,
    freeable,
    freeableOf,
    freeing,
    free,
    /** The computer's free space: more once some is freed. */
    left: `${Math.round(DISK - sum(KINDS.map(({ kind }) => kindSize(kind))))} GB`,
    recount: () => setCounted(0),
  };
}
