import { useEffect } from "react";

import { showToast } from "../components/toast";
import { useDaemon } from "../daemon";
import { errorText, run, store } from "../onboarding/api";

/** What Rust measures for Settings › Storage, in bytes. */
export type Kind = "worktrees" | "build" | "temp" | "history" | "browser";
type Own = Exclude<Kind, "browser">;
/** The two things Free up space takes: live chats' finished workers' build files, and archived chats' leftovers. */
export type Group = "build" | "left";
/** A chat's own files, or one of its workers'. `goes`: the kinds Rust says can go now, each with its group. */
export type Holder = { id: string; title: string; archived: boolean; worker: boolean; working: boolean; unmerged: boolean; goes: Partial<Record<Own, Group>> };
export type Chat = Holder & { project: string | null; workers: Holder[] };

/** What is counted so far: the chats, and each kind as it lands. */
export type Counted = {
  chats?: Chat[];
  /** The disk's free space. */
  free?: number | null;
  sizes: Partial<Record<Own, Record<string, number>>>;
  browser?: number;
  freeing: { done: number; total: number } | null;
  error?: string;
};

export const KINDS: { kind: Kind; label: string; fill: string }[] = [
  { kind: "build", label: "Build files", fill: "bg-tile-sky" },
  { kind: "worktrees", label: "Worktrees", fill: "bg-tile-violet" },
  { kind: "temp", label: "Temp files", fill: "bg-tile-sunflower" },
  { kind: "history", label: "Chat history", fill: "bg-tile-mint" },
  { kind: "browser", label: "Browser data", fill: "bg-tile-coral" },
];
export const PER_CHAT: readonly Own[] = ["build", "worktrees", "temp", "history"];

export const GROUPS: { group: Group; label: string; line: string }[] = [
  { group: "build", label: "Finished workers' build files", line: "The next build makes them again. Their code stays." },
  { group: "left", label: "Leftovers of archived chats", line: "Build files, temp files, and worktrees with nothing unmerged. Unarchive makes the worktree again." },
];

const GB = 1e9;
/** Less than this counts as none, where a part of it all is drawn or offered. */
export const SOME = 0.05 * GB;
/** The chats the page names; the rest are counted together. */
const NAMED = 10;

export const gb = (size: number) => (size >= 0.95 * GB ? `${(size / GB).toFixed(1)} GB` : `${Math.round(size / 1e6)} MB`);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const holdersOf = (chat: Chat): Holder[] => [chat, ...chat.workers];

export type Storage = ReturnType<typeof storageOf>;

/** The page's sums over what is counted; `named`: how many chats it names. */
export function storageOf(counted: Counted, acts: { free: (groups: readonly Group[]) => void; recount: () => void }, named = NAMED) {
  const { sizes, freeing } = counted;
  const ready = (kind: Kind) => (kind === "browser" ? counted.browser !== undefined : sizes[kind] !== undefined);
  const sizeOf = (holder: Holder, kind: Own) => sizes[kind]?.[holder.id] ?? 0;
  const holderSize = (holder: Holder) => sum(PER_CHAT.map((kind) => sizeOf(holder, kind)));
  const chatSize = (chat: Chat, kind?: Own) => sum(holdersOf(chat).map((holder) => (kind ? sizeOf(holder, kind) : holderSize(holder))));
  const kindSize = (kind: Kind) => (kind === "browser" ? (counted.browser ?? 0) : sum(Object.values(sizes[kind] ?? {})));
  const total = sum(KINDS.map(({ kind }) => kindSize(kind)));
  const all = [...(counted.chats ?? [])].sort((a, b) => chatSize(b) - chatSize(a));
  const chats = all.slice(0, named);
  const smaller = all.slice(named);
  /** What Free up space takes of one chat or worker. */
  const freeableOf = (holder: Holder, group?: Group) => sum(PER_CHAT.map((kind) => (holder.goes[kind] && (!group || holder.goes[kind] === group) ? sizeOf(holder, kind) : 0)));
  const freeableIn = (chat: Chat, group?: Group) => sum(holdersOf(chat).map((holder) => freeableOf(holder, group)));
  return {
    counting: !counted.error && (!counted.chats || KINDS.some(({ kind }) => !ready(kind))),
    error: counted.error,
    ready,
    kindSize,
    total,
    chats,
    smaller,
    /** What the smaller chats take together. */
    rest: sum(smaller.map((chat) => chatSize(chat))),
    chatSize,
    holderSize,
    freeableIn,
    freeable: (group?: Group) => sum(all.map((chat) => freeableIn(chat, group))),
    freeing,
    disk: counted.free,
    ...acts,
  };
}

const NONE: Counted = { sizes: {}, freeing: null };
const counted = store<Counted>(NONE);
const patch = (change: Partial<Counted>) => counted.set({ ...counted.get(), ...change });

// Kept while other pages show: a count goes on, and coming back starts no other.
let counting = 0;
let asked = false;

async function list(): Promise<Pick<Counted, "chats" | "free">> {
  const reply = await run(["storage"]);
  return { chats: reply.chats as Chat[], free: reply.free as number | null };
}

/** Counts it all, each part shown as it lands. */
function recount(): void {
  const mine = ++counting;
  asked = true;
  counted.set(NONE);
  const land = (asking: Promise<Partial<Counted> | (() => Partial<Counted>)>) =>
    asking.then(
      (change) => mine === counting && patch(typeof change === "function" ? change() : change),
      (cause: unknown) => {
        if (mine !== counting) return;
        // The daemon went: counted again once it's back.
        if (errorText(cause) === "disconnected") asked = false;
        else patch({ error: errorText(cause) });
      },
    );
  void land(list());
  for (const kind of PER_CHAT) void land(run(["storage", kind]).then((reply) => () => ({ sizes: { ...counted.get().sizes, [kind]: reply.sizes as Record<string, number> } })));
  void land(run(["storage", "browser"]).then((reply) => ({ browser: reply.total as number })));
}

/** Frees each chat and worker in `groups`, one by one; what Rust no longer lets go stays. */
async function free(groups: readonly Group[]): Promise<void> {
  if (counted.get().freeing) return;
  const now = storageOf(counted.get(), { free: () => {}, recount });
  const jobs = groups.flatMap((group) => [...now.chats, ...now.smaller].flatMap(holdersOf).map((holder) => ({ group, holder, size: sum(PER_CHAT.map((kind) => (holder.goes[kind] === group ? (counted.get().sizes[kind]?.[holder.id] ?? 0) : 0))) })));
  const asking = jobs.filter((job) => job.size > 0);
  const total = sum(asking.map((job) => job.size));
  let [done, freed] = [0, 0];
  const failed: string[] = [];
  patch({ freeing: { done, total } });
  for (const { group, holder, size } of asking) {
    try {
      const went = (await run(["storage", "free", group, holder.id])).went as Own[];
      const sizes = { ...counted.get().sizes };
      for (const kind of went) {
        freed += sizes[kind]?.[holder.id] ?? 0;
        sizes[kind] = { ...sizes[kind], [holder.id]: 0 };
      }
      patch({ sizes });
    } catch (cause) {
      const why = errorText(cause);
      failed.push(`“${holder.title || "New session"}”: ${why === "disconnected" ? "Brigadier isn't running" : why}`);
      if (why === "disconnected") break;
    }
    done += size;
    patch({ freeing: { done, total } });
  }
  patch({ freeing: null });
  if (failed.length > 0) {
    showToast(`Freed ${gb(freed)}. Couldn't free up ${failed.length === 1 ? failed[0] : `${failed.length} chats and workers, first ${failed[0]}`}`, { tone: "error" });
    // What it left half gone is counted anew.
    return recount();
  }
  showToast(`Freed ${gb(freed)}`);
  list().then(patch, (cause: unknown) => console.error(cause));
}

/** Counted as the page first shows, and again on Refresh. */
export function useStorage(): Storage {
  const online = Boolean(useDaemon().daemon);
  useEffect(() => {
    if (online && !asked) recount();
  }, [online]);
  return storageOf(counted.use(), { free: (groups) => void free(groups), recount });
}
