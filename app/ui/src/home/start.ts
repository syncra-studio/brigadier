import { useEffect, useSyncExternalStore } from "react";

import { daemonRun } from "../session/composer";
import { type Draft, EMPTY_DRAFT, isEmpty } from "../components/composer/draft";
import { draftOf, HOME_DRAFT, keepDraft, loadDraft, moveDraft, oldProject } from "../session/draft";
import { dropTiles } from "../session/files";
import type { ModelChoice } from "../components/composer/model-picker";
import type { PermissionLevel } from "../components/composer/pickers";
import { ask, openThread, type Row, threadSource, useDaemon, useThread } from "../daemon";
import { store } from "../onboarding/api";
import { type Shown, useProjects } from "../projects/projects";
import { newId } from "../session/store";
import { carryHome, CHAT, closeTab, HOME, isRef, openTab, rereadTabs, selectTab, setHomeTabs, type Tab, tabsOf, tabsSettled, takeTabs } from "../shell/tab-store";
import { prName, prPageHash, reviewChats } from "../pull-requests/route";
import type { WorkIn } from "./pills";
import { placeOnOpen, sendFailed } from "../thread/follow";

/*
 * Home's draft and the sessions it starts [D30, D161]. Its project and model live in memory; its words are kept by
 * Rust, like a session's draft. A send makes the session's id and its message's command id here, opens the session at once and
 * runs `start` behind it. Until Rust's row exists the row shows from here, under the short title Rust gives the
 * message [D186]; the message shows until Rust says how it went, by its command id [D54]:
 * - delivered: done, once the open thread has its turn;
 * - logged (in the log, delivery not proven): the session is "undelivered", and Try again is Rust's recover;
 * - refused or not logged: Try again runs the same start again, which finishes a setup cut short;
 * - the link lost: asked again under the same ids on reconnect, where a logged id is never sent twice.
 * Discard takes a made session away through Rust's delete [D35]; if that fails, it stays with the reason.
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
  /** Brigade picked here, for the next session only: a session is one from its first message or never [D209]. */
  brigade?: boolean;
  /** Bumped to put the cursor in the field. */
  focus: number;
  /** A PR sent to the agent, while Home is in its project in a new worktree [D699]. */
  pr?: PrStart;
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
    // Its model and the like go along; a PR's branch or a chat's worktree is this project's only.
    const own = { ...now, pr: undefined, once: undefined };
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
  asking: boolean;
  /** The link dropped before an answer: asked again on reconnect. */
  unknown?: boolean;
  error?: string;
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
  if (!get(id)) return;
  if (reply.error === "disconnected") return put(id, { asking: false, unknown: true });
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
  put(id, { asking: false, unknown: false, error: reason(reply) });
  if (!get(id)!.fork) sendFailed(get(id)!.cid);
  rereadTabs(get(id)!.draft ?? HOME_DRAFT);
}

function runStart(entry: Starting): void {
  put(entry.id, { asking: true, unknown: false, error: undefined });
  // Rust's short title, back long before the worktree is made [D186]; asked again if the link took it.
  if (!entry.title) ask({ op: "run", args: ["title", entry.text] }, (reply) => reply.ok && put(entry.id, { title: reply.title }));
  ask({ op: "run", args: entry.args }, (reply) => land(entry.id, reply));
}

/** A new session's id, made here so its row and thread show before Rust has it [D30]. */
export const sessionId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** A PR's session: its new worktree on the PR's branch, named after it, its page in a browser tab [D674, D689, D699]. `tab`: its PR tab's target. */
export type PrStart = { project: string; number: number; title: string; url: string; branch: string; base: string; fork: boolean; tab: string };

/** Where a project's session works: `base` for a new worktree, `worktree` for an existing one, `pr` a PR's branch. */
export type Place = { workIn: WorkIn; base: string | null; worktree: string | null; pr?: PrStart; review?: string };

const placeArgs = ({ workIn, base, worktree, pr }: Place): string[] =>
  workIn === "local"
    ? ["--local"]
    : workIn === "existing"
      ? ["--local", "--cwd", worktree!]
      : pr
        ? ["--base", pr.base, "--pr", String(pr.number), "--head", pr.branch, ...(pr.fork ? ["--fork"] : []), "--title", prTitle(pr), "--url", pr.url]
        : base
          ? ["--base", base]
          : [];
const prTitle = (pr: PrStart) => `#${pr.number} ${pr.title}`;

/** Starts a session from the draft and opens it at once; the draft's text goes. With no project it's a chat in a folder of its own [D388]. */
export function start(project: string | null, place: Place, model: ModelChoice, text: string, level?: string, parts?: string, brigade?: boolean): void {
  const id = sessionId();
  const cid = newId();
  const key = draftKey();
  const link = place.review && `\n\n${prUrl(place.review)}`;
  const args = ["start", id, "--backend", model.provider, ...(project ? ["--project", project, ...placeArgs(place)] : ["--scratch"]), "--model", model.model, "--text", text + (link || ""), "--cid", cid, ...(place.pr || place.review ? [] : ["--carry-tabs"])];
  if (model.effort) args.push("--effort", model.effort);
  if (model.fast) args.push("--fast");
  if (level) args.push("--level", level);
  if (brigade) args.push("--brigade");
  // Its files move from Home's draft folder into the session [D2022 #18].
  if (parts) args.push("--parts", link ? withLink(parts, link) : parts);
  const entry: Starting = { id, cid, project, text, parts, title: place.pr ? prTitle(place.pr) : place.review ? reviewTitle(place.review) : "", args, sent: Date.now(), asking: true, draft: key, ...(project && place.workIn === "worktree" && place.base && { worktree: { base: place.pr?.base ?? place.base } }), ...(place.review && { then: reviewStarted(id, place.review) }) };
  starting.set(new Map(starting.get()).set(id, entry));
  placeOnOpen(id, cid);
  // The next new session starts on the project's default level again, as the old app's did.
  setHomeDraft({ level: undefined, brigade: undefined, pr: undefined, once: undefined, model });
  // Its PR tab closes on Home: the session has the PR's page instead [D699].
  const tab = place.pr && tabsOf(HOME).tabs.find((each) => each.kind === "pr" && each.target === place.pr!.tab);
  if (tab) closeTab(HOME, tab.id);
  // Emptied, Rust drops the saved draft only; its files wait for the start to take them.
  keepDraft(daemonRun, key, EMPTY_DRAFT);
  window.location.hash = place.review ? prPageHash(place.review) : `#thread/${encodeURIComponent(id)}`;
  // A PR's session has Chat and the PR's page only: Home's tabs stay on Home [D706].
  if (place.pr) runStart(entry);
  else carryHome(id, () => runStart(entry));
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
  starting.set(new Map(starting.get()).set(id, entry));
  window.location.hash = `#thread/${encodeURIComponent(id)}`;
  runStart(entry);
}

/** Again: Rust's recover for a message logged but not delivered; otherwise the same start under the same ids. */
export function retry(id: string): void {
  const entry = get(id);
  if (!entry || entry.asking) return;
  if (entry.outcome !== "logged") return runStart(entry);
  put(id, { asking: true, error: undefined });
  ask({ op: "run", args: ["recover", id] }, (reply) => land(id, reply));
}

/** The start goes: a session Rust made is deleted through Rust first [D35]; Home then shows the message again, its files Home's. */
export async function discard(id: string): Promise<void> {
  const entry = get(id);
  if (!entry || entry.asking) return;
  put(id, { asking: true });
  const back = entry.fork ? { ok: true } : await daemonRun(["attach", HOME_DRAFT, "back", id, entry.parts ?? "null", ...entry.args.filter((each) => each === "--carry-tabs")]);
  if (!back.ok) return put(id, { asking: false, error: `Couldn't discard it: ${reason(back)}` });
  ask({ op: "run", args: ["delete", id] }, (reply) => {
    // Never made (no session.json): nothing of it is anywhere but here.
    const gone = reply.ok || /os error 2\b/.test(String(reply.error));
    if (!gone) return put(id, { asking: false, error: `Couldn't discard it: ${reason(reply)}` });
    put(id, null);
    if (entry.fork) {
      if (isOpen(id)) window.location.hash = `#thread/${encodeURIComponent(entry.fork.source)}`;
      return;
    }
    // Over what's been typed there since.
    const key = entry.draft ?? HOME_DRAFT;
    const words: Draft = entry.parts ? JSON.parse(entry.parts) : { parts: [entry.text], attachmentIds: [] };
    const since = draftOf(key);
    keepDraft(daemonRun, key, since && !isEmpty(since) ? { parts: [...words.parts, "\n\n", ...since.parts], attachmentIds: [...words.attachmentIds, ...since.attachmentIds] } : words);
    rereadTabs(key);
    if (isOpen(id)) newSession(entry.project);
  });
}

/**
 * Rust's rows with each start Rust has no row for yet [D30]; and, once reconnected, each start whose answer was
 * lost is asked again under the same ids. Also reopens the open session's thread when Rust's row for it arrives.
 */
export function useStartingRows(open: string | null): Row[] | undefined {
  const { daemon, rows } = useDaemon();
  const pending = starting.use();
  const thread = useThread();
  const session = useSyncExternalStore(threadSource.subscribe, threadSource.get);
  useEffect(() => {
    if (daemon) for (const entry of pending.values()) if (entry.unknown && !entry.asking) runStart(entry);
  }, [daemon]);
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
