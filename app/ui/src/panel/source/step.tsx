import { useEffect, useId, useState, useSyncExternalStore } from "react";

import { commitFiles, refreshStep, useGit } from "../git";
import type { SourceState, Step, StepError } from "../types";
import { MessageDialog } from "./action-confirms";
import { first } from "./branch-ops";
import { type ActionPick, useCreatePr } from "./create-pr";
import type { SourceData, SourceOps } from "./data";

/** Messages typed after a writer failure and not committed yet, by checkout: they outlive the view [D1203, D1293]. */
const unsent = new Map<string, string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The commit message for `key`'s checkout; with no key, this view's own. */
function useMessage(key: string | undefined): [string, (next: string) => void] {
  const [own, setOwn] = useState("");
  const message = useSyncExternalStore(subscribe, () => (key ? (unsent.get(key) ?? "") : own));
  const setMessage = (next: string) => {
    if (!key) return setOwn(next);
    if (next) unsent.set(key, next);
    else unsent.delete(key);
    for (const listener of listeners) listener();
  };
  return [message, setMessage];
}

/** Commit only under way, and how the last commit ended, by checkout [D1143, D1144, D1148]. `failed`: the writer wrote nothing for these changes, named by HEAD and paths, so it goes once they change. */
type Work = { committing: boolean; failed: string | null; error: string | null };
const IDLE: Work = { committing: false, failed: null, error: null };
const works = new Map<string, Work>();

function useWork(key: string | undefined): [Work, (next: Partial<Work>) => void] {
  const [own, setOwn] = useState(IDLE);
  const work = useSyncExternalStore(subscribe, () => (key ? (works.get(key) ?? IDLE) : own));
  const put = (next: Partial<Work>) => {
    if (!key) return setOwn((now) => ({ ...now, ...next }));
    works.set(key, { ...(works.get(key) ?? IDLE), ...next });
    for (const listener of listeners) listener();
  };
  return [work, put];
}

const LOST = "Brigadier isn't connected.";

/**
 * A landing under way or refused, by checkout: it outlives the view [D30]. `on`: the step it ran from; its refusal shows while that step does.
 */
type Landing = { running: boolean; error: StepError | null; on: Step["kind"] | null };
const STILL: Landing = { running: false, error: null, on: null };
const landings = new Map<string, Landing>();

function useLanding(key: string | undefined): [Landing, (next: Landing) => void] {
  const [own, setOwn] = useState(STILL);
  const landing = useSyncExternalStore(subscribe, () => (key ? (landings.get(key) ?? STILL) : own));
  const set = (next: Landing) => {
    if (!key) return setOwn(next);
    landings.set(key, next);
    for (const listener of listeners) listener();
  };
  return [landing, set];
}

/** Per session, the view whose Create PR… opened the dialog: its open state is the session's, so one view draws it. */
const asked = new Map<string, string>();

/**
 * The summary card's git step [D1015]: its moves and the confirms they ask [D1145, D1148, D1199], with the branch's
 * PRs and Create PR [D1030]. With files uncommitted a landing commits them first, in one Rust move pinned to the step
 * it showed [D1049, D1203, D1207]. Off while the session's agent works [D1208]. `session`: whose PR it makes; none in
 * the gallery. A card draws Create PR's dialog when it opened it, or when none did. `ops`: Rust's moves, landing among
 * them (2.22), whose presence also makes the commit and the writer Rust's [D1029]; none in the gallery. `run` takes
 * the step, `onPick` a pick of its menu.
 */
export function useSourceStep({ data, state, draftKey, session = null, ops }: {
  data: SourceData;
  state: SourceState | null;
  draftKey?: string;
  session?: string | null;
  ops?: SourceOps;
}) {
  const [message, setMessage] = useMessage(draftKey);
  const [work, put] = useWork(draftKey);
  const { committing } = work;
  const live = ops !== undefined;
  const [landed, setLanded] = useLanding(draftKey);
  // Type a message…'s field while it's open; Save keeps it as the next commit's [D1203, D1293].
  const [editing, setEditing] = useState<string | null>(null);
  const step = data.step;
  const pending = step && "commit" in step ? (step.commit ?? 0) : 0;
  const pinned = data.at ?? null;
  const saved = message.trim() || null;
  const pr = useCreatePr(session, pending > 0 && pinned ? { at: pinned, message: saved, sent: () => saved && setMessage("") } : null);
  const id = useId();
  const target = useGit().target;
  // shortcut: the host module's one read of the branch's PRs until 2.27's watch sends them in `data.prs`.
  const prs = data.prs ?? pr.prs;
  const claim = session ? asked.get(session) : undefined;
  const drawsPr = claim === id || claim === undefined;
  useEffect(() => () => void (session && asked.get(session) === id && asked.delete(session)), [session, id]);

  // A watch that failed after its first read: the last read stays, read-only, under the error [D30].
  const stale = state !== null && Boolean(data.error);
  const working = data.agentWorking ?? false;
  const locked = (data.offline ?? false) || stale || committing;
  const resolving = state?.merging != null || state?.rebasing != null;
  const clean = state !== null && state.staged.length === 0 && state.changes.length === 0 && !resolving;
  const uncommittedPaths = state ? [...new Set([...state.staged, ...state.changes].map((file) => file.path))] : [];
  const changes = `${pinned?.head ?? ""}:${uncommittedPaths.join("\n")}`;
  const failed = work.failed === changes;

  /** The commit: every change, with the typed message or the writer's [D1029, D1203]. */
  const commit = () => {
    if (!state || locked || clean || working) return;
    put({ failed: null, error: null, committing: true });
    if (!live) return void setTimeout(() => put({ committing: false, ...(saved ? {} : { failed: changes }) }), 1500);
    const sent = commitFiles(true, saved ?? "", (reply) => {
      put({ committing: false });
      if (reply.ok) return saved && setMessage("");
      if (reply.writer) return writerFailed();
      put({ error: reply.error === "disconnected" ? LOST : String(reply.error) });
    });
    if (!sent) put({ committing: false, error: LOST });
  };
  // A writer failure commits nothing: the message's field opens to type one [D1029, D1293].
  const writerFailed = () => {
    put({ failed: changes });
    setEditing(message);
  };

  /**
   * The landing move, committing every change first when there are some (`first`): "Merging…" at once, until the
   * step it led to shows; a refusal stays on the line [D30, D1049, D1203].
   */
  const go = (verb: "merge" | "sync" | "publish") => {
    if (!step) return;
    const on = step.kind;
    setLanded({ running: true, error: null, on });
    put({ failed: null, error: null });
    if (!live) return void setTimeout(() => setLanded(STILL), 1500);
    if (pending === 0 && verb === "merge") {
      if (!ops?.land) return setLanded(STILL);
      return ops.land(pinned, (error) => setLanded({ running: false, error: error ? { kind: on, reason: error } : null, on }));
    }
    if (!target || !pinned) return setLanded({ running: false, error: { kind: on, reason: "Look again." }, on });
    first(target, [verb, pinned.head, pinned.base ?? "-", ...(saved ? ["--message", saved] : [])], (reply) => {
      if (reply.ok) {
        if (saved) setMessage("");
        return refreshStep(() => setLanded(STILL));
      }
      if (reply.writer) {
        setLanded(STILL);
        return writerFailed();
      }
      setLanded({ running: false, error: { kind: on, reason: reply.error === "disconnected" ? LOST : String(reply.error) }, on });
      refreshStep();
    });
  };
  const run = () => {
    if (!step || working || data.syncing) return;
    if (step.kind === "commit" || step.kind === "folderCommit") commit();
    else if (step.kind === "merge") go("merge");
    else if ((step.kind === "sync" || step.kind === "publish") && pending === 0 && ops?.branch) ops.branch[step.kind]();
    else if (step.kind === "sync" || step.kind === "publish") go(step.kind);
    // Fix with agent and Resolve with agent leave a chip above the composer, sent when the user sends [D1019, D1044]:
    // wired with the composer.
  };

  const onPick = (pick: ActionPick) => {
    if (session && pick === "createPr") asked.set(session, id);
    pr.onPick(pick);
    if (pick === "commit") commit();
  };

  const dialogs = (
    <>
      <MessageDialog
        open={editing !== null}
        message={editing ?? ""}
        failed={failed}
        onMessage={setEditing}
        onCancel={() => setEditing(null)}
        onSave={() => {
          setMessage((editing ?? "").trim());
          setEditing(null);
          put({ failed: null });
        }}
      />
      {drawsPr && pr.dialog}
    </>
  );

  return { prs, locked, work, landing: landed, run, onPick, dialogs };
}
