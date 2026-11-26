import { useEffect, useSyncExternalStore } from "react";

import { daemonRun, failure } from "../session/composer";
import { type Draft, EMPTY_DRAFT, isEmpty } from "../components/composer/draft";
import { draftOf, HOME_DRAFT, keepDraft, loadDraft, moveDraft, oldProject, resyncDraft, revOf, takeBack } from "../session/draft";
import { adopt, draftArgs, keep } from "../session/sent";
import { flagOf, forget, goingOf, type Going, keptOf, UNCONFIRMED } from "../session/uncertain";
import { dropTiles } from "../session/files";
import type { ModelChoice } from "../components/composer/model-picker";
import type { PermissionLevel } from "../components/composer/pickers";
import { ask, openThread, type Row, threadSource, useDaemon, useThread } from "../daemon";
import { store } from "../onboarding/api";
import { type Shown, useProjects } from "../projects/projects";
import { newId } from "../session/store";
import { carryHome, CHAT, HOME, isRef, openTab, rereadTabs, selectTab, setHomeTabs, type Tab, tabsSettled, takeTabs } from "../shell/tab-store";
import { prName, prPageHash, reviewChats } from "../pull-requests/route";
import type { WorkIn } from "./pills";
import { sendFailed } from "../thread/follow";
import { placeOnOpen } from "../thread/place";

/*
 * Home's draft and the sessions it starts [D30, D161]. Its project and model live in memory; its words are kept by
 * Rust, like a session's draft. A send makes the session's id and its message's command id here, opens the session at once and
 * runs `start` behind it. Until Rust's row exists the row shows from here, under the short title Rust gives the
 * message [D186]; the message shows until Rust says how it went, by its command id [D54]:
 * - delivered: done, once the open thread has its turn;
 * - logged (in the log, delivery not proven): the session is "undelivered", and Try again is Rust's recover;
 * - refused or not logged: Try again runs the same start again, which finishes a setup cut short;
 * - the link lost: asked again under the same ids on reconnect, where a logged id is never sent twice.
 * Kept first in the app's own store (uncertain.ts), then in Rust's book of the Home draft it came from (`--home`), so a
 * reload shows it again; Try again is Rust's `retry` of it, Discard Rust's `drop` [C65]. Refused, Rust takes back what
 * the session took and deletes it, then gives its words back to that draft; one whose worktree was made stays, with the
 * reason, until Discard. A made session that can't be deleted stays with the reason too [D35].
 */

export type HomeDraft = {
  /** The project this is the draft of; null: Chats', a chat in no project [D388]. */
  project: string | null;
  workIn: WorkIn;
  /** The base branch or existing worktree picked here, for that project only. */
  spot?: { project: string; base?: string; worktree?: string };
  /** A model picked here; null: the project's last one. */
  model: ModelChoice | null;
  /** The permission level picked here (1t's LevelPicker); unset: Rust's default for the project. */
  level?: PermissionLevel;
  /** Overnight picked here, for the next session only. */
  overnight?: boolean;
  /** Bumped to put the cursor in the field. */
  focus: number;
  /** A chat's "New chat in this worktree": this draft only works in that worktree, the remembered `workIn` untouched [D152]. */
  once?: { project: string; worktree: string; name: string };
  /** A PR's review chat not started yet, on the Pull Requests page: its ref [D162]. */
  review?: string;
};
// The project of the draft last open, "" for Chats', so a relaunch opens it again; never set: nothing yet, or an older build's.
const LAST = "home.project";
const FRESH: HomeDraft = { project: null, workIn: "worktree", model: null, focus: 0 };
/** Review chats' draft and tabs, one for every PR not yet asked about; in no project [D162]. */
const REVIEW_DRAFT = `${HOME_DRAFT}:review`;
/** Where a draft's words and tabs are kept: each project has one, and Chats one. */
export const draftKey = (d: Pick<HomeDraft, "project" | "review"> = draft.get()) => (d.review ? REVIEW_DRAFT : d.project ? `${HOME_DRAFT}:${d.project}` : HOME_DRAFT);
const draft = store<HomeDraft>({ ...FRESH, project: localStorage.getItem(LAST) || null });
setHomeTabs(draft.get().project);
export const useHomeDraft = draft.use;
// Each draft as it was left, by its key.
const kept = new Map<string, HomeDraft>();
/** A change that moves to another draft keeps this one, its tabs with it, and takes that one back as it was left. */
export function setHomeDraft(change: Partial<HomeDraft>): void {
  const now = draft.get();
  const next = { ...now, ...change };
  if (next.project !== now.project) localStorage.setItem(LAST, next.project ?? "");
  const [from, to] = [draftKey(now), draftKey(next)];
  if (from === to) return draft.set(next);
  kept.set(from, now);
  // The review chat's draft holds the project of the one it was opened over, which comes back after it.
  draft.set({ ...(kept.get(to) ?? FRESH), ...change, project: next.project, focus: next.focus });
  setHomeTabs(next.review ? null : next.project, next.review && REVIEW_DRAFT);
}

/** `project`'s draft, or Chats', as it was left, with the cursor in the field [D184]. */
export function newSession(project: string | null): void {
  setHomeDraft({ project, review: undefined, focus: draft.get().focus + 1 });
  window.location.hash = "";
}

/** Home in `project`, its next session working in `worktree` (`name`: its chat's) once: a chat's "New chat in this worktree" [D152]. */
export function newChatIn(project: string, worktree: string, name: string): void {
  newSession(project);
  setHomeDraft({ once: { project, worktree, name } });
  selectTab(HOME, CHAT);
}

/** New chat, from anywhere: the draft last open, as it was left; with one open already, nothing changes. */
export function newChat(): void {
  if (window.location.hash === "") return;
  newSession(draft.get().project);
}

const keyOf = (project: string | null) => draftKey({ project });
/** Words, chips and files go from one draft to another, which has none. */
function moveWords(from: string, to: string): void {
  moveDraft(daemonRun, from, to);
  dropTiles(from);
}

/** A tab that shows the same in any project, or none: files, terminals and the like read their draft's. */
const anywhere = (tab: Tab, project: string | null) => tab.kind === "new" || tab.kind === "browser" || tab.kind === "attachment" || (tab.kind === "note" && project === null) || (tab.kind === "pr" && isRef(tab.target));

/**
 * A draft's own project picker: another project's draft, or Chats'. What's typed here goes along when that one is
 * empty, with the tabs that show the same there; the rest stay. One with words or tabs of its own opens as it was left.
 */
export async function pickHomeProject(project: string | null): Promise<void> {
  const [from, to] = [draftKey(), keyOf(project)];
  if (from === to) return;
  const [here, there] = await Promise.all([tabsSettled(from), tabsSettled(to), loadDraft(daemonRun, to)]);
  const theirs = draftOf(to);
  // Moved on meanwhile, or Rust hasn't said what's in that one.
  if (draftKey() !== from || !theirs) return;
  if (isEmpty(theirs) && there.tabs.length === 0) {
    const now = draft.get();
    // Its model and the like go along; a chat's worktree is this project's only.
    const own = { ...now, once: undefined };
    kept.set(to, own);
    moveWords(from, to);
    takeTabs(from, to, here.tabs.filter((tab) => anywhere(tab, now.project)).map((tab) => tab.id));
    draft.set(own);
  }
  setHomeDraft({ project });
}

/**
 * Once, on the first launch with a draft for each project: the one New chat draft of before goes to the project it
 * showed, words and tabs: the one picked in it, else the one last sent to, else the first added. That project's own
 * words stay, and New chat's are then Chats', with the tabs that show the same there.
 */
export async function splitNewChat(projects: Shown[], rows: Row[]): Promise<void> {
  if (localStorage.getItem(LAST) !== null) return;
  const [old] = await Promise.all([tabsSettled(HOME_DRAFT), loadDraft(daemonRun, HOME_DRAFT)]);
  const words = draftOf(HOME_DRAFT);
  if (!words) return;
  const picked = oldProject(HOME_DRAFT);
  const latest = rows.filter((row) => row.project).toSorted((a, b) => b.sent - a.sent)[0]?.project;
  const none = picked === null || (picked === undefined && isEmpty(words) && old.tabs.length === 0);
  const project = none ? undefined : (projects.find((each) => each.id === picked) ?? projects.find((each) => each.id === latest) ?? projects[0])?.id;
  if (project) {
    const to = keyOf(project);
    await Promise.all([tabsSettled(to), loadDraft(daemonRun, to)]);
    const theirs = draftOf(to);
    if (!theirs) return;
    const goes = isEmpty(theirs) || isEmpty(words);
    if (goes) moveWords(HOME_DRAFT, to);
    takeTabs(HOME_DRAFT, to, old.tabs.filter((tab) => goes || !anywhere(tab, project)).map((tab) => tab.id));
    if (draft.get().project === null && isEmpty(draftOf(HOME_DRAFT)!)) setHomeDraft({ project });
  }
  if (localStorage.getItem(LAST) === null) localStorage.setItem(LAST, "");
}

/** `outcome` is Rust's for the message; `asking` while a command is out; `error` why it didn't go. */
export type Starting = {
  id: string;
  cid: string;
  project: string | null;
  text: string;
  /** The draft as Rust takes it, when it holds more than words. */
  parts?: string;
  title: string;
  args: string[];
  sent: number;
  outcome?: "delivered" | "logged";
  /** Refused because no account it could start on is signed in: its line offers Sign in [C36]. */
  signIn?: boolean;
  asking: boolean;
  /** The link dropped before an answer: asked again on reconnect. */
  unknown?: boolean;
  error?: string;
  /** It may have reached its agent: Rust couldn't say. */
  maybe?: boolean;
  /** Its session couldn't be deleted: only Discard goes on with it. */
  left?: boolean;
  /** The Home draft it was sent from, which Discard puts the words back in. */
  draft?: string;
  /** A fork of session `source` [D1063]: no message; `cid` is the answer's, whose turn its thread starts with. */
  fork?: { source: string; where: string };
  /** Starting in a new worktree from `base`, so its setup shows before Rust's first word on it [D77]. */
  worktree?: { base: string };
  /** Run once Rust delivered it. */
  then?: () => void;
};
const starting = store<ReadonlyMap<string, Starting>>(new Map());
// Each start's title, kept past the start: Rust's row is untitled until its index reads the first message, after the thread has it.
const titles = new Map<string, string>();
export const useStarting = starting.use;

const get = (id: string) => starting.get().get(id);
const add = (entry: Starting) => starting.set(new Map(starting.get()).set(entry.id, entry));
function put(id: string, change: Partial<Starting> | null): void {
  const next = new Map(starting.get());
  const now = next.get(id);
  if (change === null) next.delete(id);
  else if (now) next.set(id, { ...now, ...change });
  starting.set(next);
}

const reason = (reply: Record<string, any>) => String(reply.message ?? reply.error ?? "Refused");
const isOpen = (id: string) => window.location.hash === `#thread/${encodeURIComponent(id)}`;

/** A start's or recover's reply, read by its outcome, never by the session merely existing. */
function land(id: string, reply: Record<string, any>): void {
  const entry = get(id);
  if (!entry) return;
  if (reply.error === "disconnected") return put(id, { asking: false, unknown: true });
  const key = entry.draft ?? HOME_DRAFT;
  // Rust's book has it now, or what came of it: the app's copy goes.
  if (!entry.fork) forget(key, entry.cid);
  if (reply.given_back) {
    // Its session is gone, Rust says: its words and files are the draft's again, over what's typed there since.
    if (Array.isArray(reply.parts)) takeBack(daemonRun, key, { cid: entry.cid, parts: reply.parts, attachmentIds: reply.attachmentIds ?? [], error: reply.ok ? undefined : reason(reply) });
    else resyncDraft(daemonRun, key);
    put(id, null);
    rereadTabs(key);
    if (isOpen(id)) newSession(entry.project);
    return;
  }
  // In its session's log already, or settled: the session's own row and recover take over [D54].
  if (reply.went || reply.result === "went" || reply.result === "settled") return put(id, null);
  // A fork answers with its session once it holds all it needs [D35].
  const result = (reply.result ?? (reply.ok && reply.session ? "delivered" : undefined)) as string | undefined;
  if (result === "delivered") {
    // Kept until Rust's row has it and, when open, its thread has the turn (useStartingRows).
    put(id, { asking: false, unknown: false, outcome: "delivered", error: undefined });
    get(id)!.then?.();
    // It read "not found" before Rust had it: only the open thread is asked again [D40].
    if (isOpen(id)) openThread(id);
    return;
  }
  if (result === "logged") return put(id, { asking: false, unknown: false, outcome: "logged", error: reply.error ? String(reply.error) : "It reached the log, but not the agent." });
  put(id, { asking: false, unknown: false, error: reason(reply), maybe: reply.unsettled === true, left: reply.left === true, signIn: reply.error === "sign_in" });
  if (!entry.fork) sendFailed(entry.cid);
  rereadTabs(key);
}

function runStart(entry: Starting): void {
  put(entry.id, { asking: true, unknown: false, error: undefined });
  // Rust's short title, back long before the worktree is made [D186]; asked again if the link took it.
  if (!entry.title) ask({ op: "run", args: ["title", entry.text] }, (reply) => reply.ok && put(entry.id, { title: reply.title }));
  const kept = entry.draft === undefined ? undefined : keptOf(entry.draft, entry.cid);
  ask({ op: "run", args: [...entry.args, ...(kept ? draftArgs(kept.draft, kept.rev ?? null) : [])] }, (reply) => land(entry.id, reply));
}

/** The app's copy of `entry` to Rust first, if Rust may not have it: null once Rust's book has it, else Rust's answer. */
async function booked(entry: Starting): Promise<Record<string, any> | null> {
  const kept = keptOf(entry.draft ?? HOME_DRAFT, entry.cid);
  const adopted = kept && !kept.booked ? await adopt(daemonRun, entry.draft ?? HOME_DRAFT, kept) : { kept: true };
  return adopted.kept ? null : adopted;
}

/**
 * Each start Home's draft `key` holds, in Rust's book or as the app's own copy whose reply never came, shown again
 * after a reload; a copy Rust may not have is handed to it [C65]. PROPOSED: "it couldn't be confirmed" for one Rust
 * holds but can't say of.
 */
async function restore(key: string): Promise<void> {
  await loadDraft(daemonRun, key);
  for (const each of goingOf(key).filter((one) => one.kind === "start" && one.op[1] && !get(one.op[1]))) {
    const entry: Starting = { id: each.op[1], cid: each.cid, project: flagOf(each.op, "--project") ?? null, text: flagOf(each.op, "--text") ?? "", parts: flagOf(each.op, "--parts"), title: "", args: each.op, sent: each.at, asking: false, draft: key, error: each.stuck ?? UNCONFIRMED, maybe: each.reached !== false, left: each.left };
    add(entry);
    if (!each.booked) void booked(entry).then((reply) => reply && reply.error !== "disconnected" && land(entry.id, reply));
  }
}

/** A new session's id, made here so its row and thread show before Rust has it [D30]. */
export const sessionId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Where a project's session works: `base` for a new worktree, `worktree` for an existing one. */
export type Place = { workIn: WorkIn; base: string | null; worktree: string | null; review?: string };

const placeArgs = ({ workIn, base, worktree }: Place): string[] =>
  workIn === "local"
    ? ["--local"]
    : workIn === "existing"
      ? ["--local", "--cwd", worktree!]
      : base
        ? ["--base", base]
        : [];

/** Starts a session from the draft and opens it at once; the draft's text goes. With no project it's a chat in a folder of its own [D388]. */
export function start(project: string | null, place: Place, model: ModelChoice, text: string, level?: string, parts?: string, overnight?: boolean): void {
  const id = sessionId();
  const cid = newId();
  const key = draftKey();
  const link = place.review && `\n\n${prUrl(place.review)}`;
  const args = ["start", id, "--backend", model.provider, ...(project ? ["--project", project, ...placeArgs(place)] : ["--scratch"]), "--model", model.model, "--text", text + (link || ""), "--cid", cid, "--home", key, ...(place.review ? [] : ["--carry-tabs"])];
  if (model.effort) args.push("--effort", model.effort);
  if (model.fast) args.push("--fast");
  if (level) args.push("--level", level);
  if (overnight) args.push("--overnight");
  // Its files move from Home's draft folder into the session [D2022 #18].
  if (parts) args.push("--parts", link ? withLink(parts, link) : parts);
  const entry: Starting = { id, cid, project, text, parts, title: place.review ? reviewTitle(place.review) : "", args, sent: Date.now(), asking: true, draft: key, ...(project && place.workIn === "worktree" && place.base && { worktree: { base: place.base } }), ...(place.review && { then: reviewStarted(id, place.review) }) };
  add(entry);
  // Kept before the field empties, with the draft it came from and the revision then, so a reload loses nothing.
  const words: Draft = parts ? JSON.parse(parts) : { parts: [text], attachmentIds: [] };
  keep(key, { cid, kind: "start", op: args, draft: words, rev: revOf(key), at: entry.sent } satisfies Going);
  placeOnOpen(id, cid);
  // The next new session starts on the project's default level again, as the old app's did.
  setHomeDraft({ level: undefined, overnight: undefined, once: undefined, model });
  // Emptied, Rust drops the saved draft only; its files wait for the start to take them.
  keepDraft(daemonRun, key, EMPTY_DRAFT);
  window.location.hash = place.review ? prPageHash(place.review) : `#thread/${encodeURIComponent(id)}`;
  carryHome(id, () => runStart(entry));
}

export const reviewTitle = (ref: string) => `Reviewing ${prName(ref)}`;
// shortcut: the PR rides in the first message as its link, not a PR chip; a chip once the composer's PR chips exist [D171].
const prUrl = (ref: string) => ref.replace(/^([^#]+)#(\d+)$/, "https://$1/pull/$2");
// Rust builds the prompt from the parts when there are any, so the link goes in them too.
function withLink(parts: string, link: string): string {
  const draft = JSON.parse(parts) as Draft;
  return JSON.stringify({ ...draft, parts: [...draft.parts, link] });
}

/** A review chat stays on the Pull Requests page as the PR's, its PR tab carried from the draft's, then kept by Rust [D162]. */
function reviewStarted(id: string, ref: string): () => void {
  reviewChats.set({ ...reviewChats.get(), [ref]: id });
  return () => {
    // Named as a review chat, not after its first message.
    ask({ op: "run", args: ["rename", id, reviewTitle(ref)] }, () => {});
    openTab(id, "pr", ref);
    openThread(id);
  };
}

/** Forks session `source` at answer `at` and opens the fork at once, pending, under the title Rust gives it [D30, D1063]. */
export function startFork(source: string, project: string | null, at: string, where: string, fingerprint: string, title: string, to?: ModelChoice): void {
  const id = sessionId();
  const args = ["fork", source, id, "--at", at, "--where", where, "--fingerprint", fingerprint];
  // Another agent or model goes on from there [D1081].
  if (to) args.push("--to", to.provider, "--model", to.model, ...(to.effort ? ["--effort", to.effort] : []), ...(to.fast ? ["--fast"] : []));
  const entry: Starting = { id, cid: at, project, text: "", title, args, sent: Date.now(), asking: true, fork: { source, where } };
  add(entry);
  window.location.hash = `#thread/${encodeURIComponent(id)}`;
  runStart(entry);
}

/** Again: Rust's recover for a message logged but not delivered; otherwise Rust's `retry` of the same start under the same ids. */
export function retry(id: string): void {
  const entry = get(id);
  if (!entry || entry.asking || entry.left) return;
  if (entry.fork) return runStart(entry);
  put(id, { asking: true, unknown: false, error: undefined });
  if (entry.outcome === "logged") return void ask({ op: "run", args: ["recover", id] }, (reply) => land(id, reply));
  void booked(entry).then((reply) => (reply ? land(id, reply) : void ask({ op: "run", args: ["draft", entry.draft ?? HOME_DRAFT, "retry", entry.cid] }, (again) => land(id, again))));
}

/** The start goes: Rust deletes what's left of its session and gives its words and files back to its draft (`drop`) [D35]; a fork's session is deleted. */
export function discard(id: string): void {
  const entry = get(id);
  if (!entry || entry.asking) return;
  put(id, { asking: true });
  if (entry.fork) {
    const fork = entry.fork;
    return void ask({ op: "run", args: ["delete", id] }, (reply) => {
      // Never made (no session.json): nothing of it is anywhere but here.
      const gone = reply.ok || /os error 2\b|no session "/.test(String(reply.error));
      if (!gone) return put(id, { asking: false, error: `Couldn't discard it: ${reason(reply)}` });
      put(id, null);
      if (isOpen(id)) window.location.hash = `#thread/${encodeURIComponent(fork.source)}`;
    });
  }
  const dropped = (reply: Record<string, any>) => {
    if (reply.given_back || reply.went) return land(id, reply);
    if (reply.ok) return put(id, null);
    put(id, { asking: false, error: reply.left ? reason(reply) : `Couldn't discard it: ${failure(reply)}`, left: reply.left === true });
  };
  void booked(entry).then((reply) => (reply ? dropped(reply) : void ask({ op: "run", args: ["draft", entry.draft ?? HOME_DRAFT, "drop", entry.cid] }, dropped)));
}

/**
 * Rust's rows with each start Rust has no row for yet [D30]; and, once reconnected, each start whose answer was
 * lost is asked again under the same ids. Also reopens the open session's thread when Rust's row for it arrives.
 */
export function useStartingRows(open: string | null): Row[] | undefined {
  const { daemon, rows, projects } = useDaemon();
  const pending = starting.use();
  const thread = useThread();
  const session = useSyncExternalStore(threadSource.subscribe, threadSource.get);
  useEffect(() => {
    if (daemon) for (const entry of pending.values()) if (entry.unknown && !entry.asking) retry(entry.id);
  }, [daemon]);
  // Every Home draft's starts, once read: after a reload, its rows come from Rust's book and the app's copies [C65].
  const keys = [HOME_DRAFT, REVIEW_DRAFT, ...(projects ?? []).map((each) => keyOf(each.id))].join("\n");
  useEffect(() => {
    if (daemon) for (const key of keys.split("\n")) void restore(key);
  }, [daemon, keys]);
  // Delivered, in Rust's rows and, when open, in its thread: nothing left to show from here.
  useEffect(() => {
    for (const entry of pending.values()) {
      const done = entry.outcome === "delivered" && rows?.some((row) => row.id === entry.id);
      if (done && (entry.id !== open || (session?.items.length && session.turns.some((turn) => turn.id === entry.cid)))) put(entry.id, null);
    }
  }, [pending, rows, open, session]);
  const known = Boolean(open && rows?.some((row) => row.id === open));
  useEffect(() => {
    if (known && open && thread?.id === open && thread.status === "missing") openThread(open);
  }, [known, open, thread?.status]);
  if (!rows) return rows;
  for (const entry of pending.values()) if (entry.title) titles.set(entry.id, entry.title);
  const named = rows.some((row) => !row.title && titles.has(row.id)) ? rows.map((row) => (row.title ? row : { ...row, title: titles.get(row.id) ?? row.title })) : rows;
  const mine = [...pending.values()].filter((entry) => !rows.some((row) => row.id === entry.id));
  if (mine.length === 0) return named;
  return [
    ...named,
    ...mine.map(({ id, project, title, sent, error, outcome, fork }) => ({
      id,
      title,
      state: error || outcome === "logged" ? "undelivered" : "starting",
      reason: null,
      mark: error ? ("amber" as const) : ("working" as const),
      resets: null,
      sent,
      finished: 0,
      project,
      backend: "",
      updated: sent,
      items: 0,
      error: error ?? null,
      forkOf: fork?.source ?? null,
    })),
  ];
}

/** Whether session `id` was just started from Home and Rust's row hasn't taken over yet. */
export const justStarted = (id: string): boolean => Boolean(get(id));

/** The start of session `id` from Home, while it has anything to show. */
export const useStart = (id: string): Starting | undefined => starting.use().get(id);

/** The open draft's project; null for Chats' [D1039]. */
export function useHomeProject(): Shown | null {
  const { project } = useHomeDraft();
  return useProjects()?.find((each) => !each.pending && each.id === project) ?? null;
}
