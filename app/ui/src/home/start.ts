import { useEffect, useSyncExternalStore } from "react";

import type { Draft } from "../components/composer/draft";
import { daemonRun } from "../session/composer";
import { HOME_DRAFT, keepDraft } from "../session/draft";
import type { ModelChoice } from "../components/composer/model-picker";
import type { PermissionLevel } from "../components/composer/pickers";
import { ask, openThread, type Row, threadSource, useDaemon, useThread } from "../daemon";
import { store } from "../onboarding/api";
import { type Shown, useProjects } from "../projects/projects";
import { newId } from "../session/store";
import { carryHome, CHAT, rereadHome, selectTab } from "../shell/tab-store";
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
  /** The project picked here; null: the last one used. */
  project: string | null;
  /** "Don't work in a project" was picked: a chat [D388]. */
  chat: boolean;
  workIn: WorkIn;
  /** The base branch or existing worktree picked here, for that project only. */
  spot?: { project: string; base?: string; worktree?: string };
  /** A model picked here; null: the project's last one. */
  model: ModelChoice | null;
  /** The permission level picked here (1t's LevelPicker); unset: Rust's default for the project. */
  level?: PermissionLevel;
  text?: Draft;
  /** Bumped to put the cursor in the field. */
  focus: number;
};
const draft = store<HomeDraft>({ project: null, chat: false, workIn: "worktree", model: null, focus: 0 });
export const useHomeDraft = draft.use;
export const setHomeDraft = (change: Partial<HomeDraft>) => draft.set({ ...draft.get(), ...change });

/** Home in `project` (⌘N in a session's project, a project picked in ⌘K), with the cursor in the field [D184]. */
export function newSession(project?: string | null): void {
  setHomeDraft({ ...(project && { project, chat: false }), focus: draft.get().focus + 1 });
  selectTab(HOME_DRAFT, CHAT);
  window.location.hash = "";
}

/** Home in no project, from the sidebar's New chat [D421]. */
export function newChat(): void {
  setHomeDraft({ chat: true, focus: draft.get().focus + 1 });
  selectTab(HOME_DRAFT, CHAT);
  window.location.hash = "";
}

/** `outcome` is Rust's for the message; `asking` while a command is out; `error` why it didn't go. */
export type Starting = {
  id: string;
  cid: string;
  project: string | null;
  text: string;
  title: string;
  args: string[];
  sent: number;
  outcome?: "delivered" | "logged";
  asking: boolean;
  /** The link dropped before an answer: asked again on reconnect. */
  unknown?: boolean;
  error?: string;
};
const starting = store<ReadonlyMap<string, Starting>>(new Map());
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
  const result = reply.result as string | undefined;
  if (result === "delivered") {
    // Kept until Rust's row has it and, when open, its thread has the turn (useStartingRows).
    put(id, { asking: false, unknown: false, outcome: "delivered", error: undefined });
    // It read "not found" before Rust had it: only the open thread is asked again [D40].
    if (isOpen(id)) openThread(id);
    return;
  }
  if (result === "logged") return put(id, { asking: false, unknown: false, outcome: "logged", error: reply.error ? String(reply.error) : "It reached the log, but not the agent." });
  put(id, { asking: false, unknown: false, error: reason(reply) });
  sendFailed(get(id)!.cid);
  rereadHome();
}

function runStart(entry: Starting): void {
  put(entry.id, { asking: true, unknown: false, error: undefined });
  // Rust's short title, back long before the worktree is made [D186]; asked again if the link took it.
  if (!entry.title) ask({ op: "run", args: ["title", entry.text] }, (reply) => reply.ok && put(entry.id, { title: reply.title }));
  ask({ op: "run", args: entry.args }, (reply) => land(entry.id, reply));
}

/** A new session's id, made here so its row and thread show before Rust has it [D30]. */
export const sessionId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Where a project's session works: `base` for a new worktree, `worktree` for an existing one. */
export type Place = { workIn: WorkIn; base: string | null; worktree: string | null };

const placeArgs = ({ workIn, base, worktree }: Place): string[] =>
  workIn === "local" ? ["--local"] : workIn === "existing" ? ["--local", "--cwd", worktree!] : base ? ["--base", base] : [];

/** Starts a session from the draft and opens it at once; the draft's text goes. With no project it's a chat in a folder of its own [D388]. */
export function start(project: string | null, place: Place, model: ModelChoice, text: string, level?: string): void {
  const id = sessionId();
  const cid = newId();
  const args = ["start", id, "--backend", model.provider, ...(project ? ["--project", project, ...placeArgs(place)] : ["--scratch"]), "--model", model.model, "--text", text, "--cid", cid, "--carry-tabs"];
  if (model.effort) args.push("--effort", model.effort);
  if (level) args.push("--level", level);
  const entry: Starting = { id, cid, project, text, title: "", args, sent: Date.now(), asking: true };
  starting.set(new Map(starting.get()).set(id, entry));
  placeOnOpen(id, cid);
  setHomeDraft({ text: undefined, model, ...(project && { project }) });
  keepDraft(daemonRun, HOME_DRAFT, []);
  window.location.hash = `#thread/${encodeURIComponent(id)}`;
  carryHome(id, () => runStart(entry));
}

/** Again: Rust's recover for a message logged but not delivered; otherwise the same start under the same ids. */
export function retry(id: string): void {
  const entry = get(id);
  if (!entry || entry.asking) return;
  if (entry.outcome !== "logged") return runStart(entry);
  put(id, { asking: true, error: undefined });
  ask({ op: "run", args: ["recover", id] }, (reply) => land(id, reply));
}

/** The start goes: a session Rust made is deleted through Rust first [D35]; Home then shows the text again. */
export function discard(id: string): void {
  const entry = get(id);
  if (!entry || entry.asking) return;
  put(id, { asking: true });
  ask({ op: "run", args: ["delete", id] }, (reply) => {
    // Never made (no session.json): nothing of it is anywhere but here.
    const gone = reply.ok || /os error 2\b/.test(String(reply.error));
    if (!gone) return put(id, { asking: false, error: `Couldn't discard it: ${reason(reply)}` });
    put(id, null);
    setHomeDraft({ ...(entry.project ? { project: entry.project, chat: false } : { chat: true }), text: { parts: [entry.text], attachmentIds: [] } });
    keepDraft(daemonRun, HOME_DRAFT, [entry.text]);
    if (isOpen(id)) window.location.hash = "";
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
  const mine = [...pending.values()].filter((entry) => !rows.some((row) => row.id === entry.id));
  if (mine.length === 0) return rows;
  return [
    ...rows,
    ...mine.map(({ id, project, title, sent, error, outcome }) => ({
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
    })),
  ];
}

/** Whether session `id` was just started from Home and Rust's row hasn't taken over yet. */
export const justStarted = (id: string): boolean => Boolean(get(id));

/** The start of session `id` from Home, while it has anything to show. */
export const useStart = (id: string): Starting | undefined => starting.use().get(id);

/** Home's project: the one picked here, else the one last sent to, else the first added; null for a chat [D1039]. */
export function useHomeProject(): Shown | null {
  const draft = useHomeDraft();
  const rows = useDaemon().rows ?? [];
  const projects = useProjects()?.filter((each) => !each.pending);
  if (draft.chat) return null;
  const latest = rows.filter((row) => row.project).toSorted((a, b) => b.sent - a.sent)[0];
  return projects?.find((each) => each.id === draft.project) ?? projects?.find((each) => each.id === latest?.project) ?? projects?.[0] ?? null;
}
