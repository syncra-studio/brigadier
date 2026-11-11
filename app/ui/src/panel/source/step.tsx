import { type ComponentProps, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { commitFiles, readDraft, refreshStep, type StepAt, useGit, writeMessage } from "../git";
import type { Commit, ForcePush, MergeStyle, SourceState, Step, StepError } from "../types";
import { laterWords } from "../words";
import { ActionButton } from "./action";
import { ForcePushDialog, MergePrDialog, MessageDialog, SquashDialog } from "./action-confirms";
import type { ActionPick } from "./action-menus";
import { askForce, cancelForce, first, forcePush, only, useBranchOp, useForcing } from "./branch-ops";
import { useCreatePr } from "./create-pr";
import type { SourceData, SourceOps } from "./panel";

/** The picks that run on real data so far [D1029, D1030, D1034, D1152, D1203, D1205]. */
const WIRED: ActionPick[] = ["commit", "editMessage", "pullOnly", "pushOnly", "createPr", "pushBranch", "openPrPage", "mergeLocally", "forcePush"];

const SQUASH_MESSAGE = `Retry failed uploads

Uploads that fail now retry three times with a growing wait, and the tray shows how far each one got.`;

/** Messages saved in Edit message… and not committed yet, by checkout: they outlive the view, and Source and the card share them [D1203]. */
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

/** Commit only under way, and how the last commit ended, by checkout: Source and the card show the same [D1143, D1144, D1148]. `failed`: the writer wrote nothing. */
type Work = { committing: boolean; failed: boolean; error: string | null };
const IDLE: Work = { committing: false, failed: false, error: null };
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
 * A landing under way or refused, by checkout: Source and the card show the same one, and it outlives the view
 * [D30]. `on`: the step it ran from; its refusal shows while that step does.
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

/** The Source views on screen: Force Push's confirm is drawn by Source, else by the summary card. */
const sources = new Set<string>();
const notify = () => {
  for (const listener of listeners) listener();
};

/**
 * Source's next step [D1015]: the action button, the commit it runs and the confirms it asks, one set for Source and
 * the summary card [D1145, D1148], with the branch's PRs and Create PR [D1030]. `session`: whose PR it makes; none in
 * the gallery. `card`: the summary card, which draws Create PR's dialog only when it opened it; Source draws it
 * otherwise. `ops`: Rust's moves, landing among them (2.22), whose presence also makes the commit and the writer
 * Rust's [D1029]; none in the gallery. `move`: the files' own move, Rust's or the gallery's local copy. `button` is
 * null while there's no step to show or nothing to do.
 */
/**
 * Source's next step [D1015]: the one button, its moves and the confirms it asks, one set for Source and the summary
 * card [D1145, D1148, D1199], with the branch's PRs and Create PR [D1030]. With files uncommitted the button's landing
 * commits them first, in one Rust move pinned to the step it showed [D1049, D1203, D1207]; Commit only and Edit
 * message… end its arrow [D1191]. Off while the session's agent works [D1208]. `session`: whose PR it makes; none in
 * the gallery. `card`: the summary card, which draws Create PR's dialog only when it opened it; Source draws it
 * otherwise. `ops`: Rust's moves, landing among them (2.22), whose presence also makes the commit and the writer
 * Rust's [D1029]; none in the gallery. `button` is null while there's no step to show or nothing to do.
 */
export function useSourceStep({ data, state, draftKey, session = null, card = false, ops }: {
  data: SourceData;
  state: SourceState | null;
  draftKey?: string;
  session?: string | null;
  card?: boolean;
  ops?: SourceOps;
}) {
  const [message, setMessage] = useMessage(draftKey);
  const [work, put] = useWork(draftKey);
  const { committing, failed } = work;
  const live = ops !== undefined;
  const [ownStyle, setOwnStyle] = useState<MergeStyle>("merge");
  const mergeStyle = data.merge ?? ownStyle;
  const [landed, setLanded] = useLanding(draftKey);
  const [squashing, setSquashing] = useState(false);
  // The commits a squash confirm showed, and what it lands: pinned when it opened [D1049].
  const [squashAt, setSquashAt] = useState<StepAt | null>(null);
  const [squashCommits, setSquashCommits] = useState<Commit[] | null>(null);
  const [squashMessage, setSquashMessage] = useState(SQUASH_MESSAGE);
  const [mergingPr, setMergingPr] = useState(false);
  // Edit message…'s field while it's open; Save keeps it as the next commit's [D1203].
  const [editing, setEditing] = useState<string | null>(null);
  const editingNow = useRef(editing);
  editingNow.current = editing;
  const [galleryForcing, setGalleryForcing] = useState<ForcePush | null>(null);
  const step = data.step;
  const pending = step && "commit" in step ? (step.commit ?? 0) : 0;
  const pinned = data.at ?? null;
  const saved = message.trim() || null;
  const pr = useCreatePr(session, pending > 0 && pinned ? { at: pinned, message: saved, sent: () => saved && setMessage("") } : null);
  const id = useId();
  // The on-screen checkout's rejected push and its confirm [D1034, D1049]; the gallery's own without one.
  const target = useGit().target;
  const rejected = useBranchOp(target).rejected ?? (target ? null : (data.rejected ?? null));
  const asking = useForcing();
  const forcing = target ? (asking?.force ?? null) : galleryForcing;
  const drawsForce = useSyncExternalStore(subscribe, () => !card || sources.size === 0);
  useEffect(() => {
    if (card) return;
    sources.add(id);
    notify();
    return () => void (sources.delete(id), notify());
  }, [card, id]);
  // shortcut: the host module's one read of the branch's PRs until 2.27's watch sends them in `data.prs`.
  const prs = data.prs ?? pr.prs;
  const claim = session ? asked.get(session) : undefined;
  const drawsPr = claim === id || (claim === undefined && !card);
  useEffect(() => () => void (session && asked.get(session) === id && asked.delete(session)), [session, id]);

  // On real data a step whose click comes later is off, saying so [D1143].
  const wired = ops?.land !== undefined;
  const later = wired && step ? laterWords(step.kind) : null;
  const landing = landed.running;
  const landError = landed.on === step?.kind ? landed.error : null;
  // A PR made or pushed here shows in the button's step at once, not at the next PR read [D1143].
  const prKey = prs.map((each) => `${each.number}:${each.state}`).join();
  useEffect(() => void (wired && ops?.refreshStep?.()), [prKey]);
  // A watch that failed after its first read: the last read stays, read-only, under the error [D30].
  const stale = state !== null && Boolean(data.error);
  const working = data.agentWorking ?? false;
  const locked = (data.offline ?? false) || stale || committing;
  const resolving = state?.merging != null || state?.rebasing != null;
  const clean = state !== null && state.staged.length === 0 && state.changes.length === 0 && !resolving;
  const uncommitted = state ? new Set([...state.staged, ...state.changes].map((file) => file.path)).size : 0;
  // Nothing to do and nothing further: no button.
  const idle = clean && (step?.kind === "commit" || step?.kind === "folderCommit");

  /** Commit only · N files: every change, with the saved message or the writer's [D1029, D1203]. */
  const commit = () => {
    if (!state || locked || clean || working) return;
    put({ failed: false, error: null, committing: true });
    if (!live) return void setTimeout(() => put({ committing: false, ...(saved ? {} : { failed: true }) }), 1500);
    const sent = commitFiles(true, saved ?? "", (reply) => {
      put({ committing: false });
      if (reply.ok) return saved && setMessage("");
      if (reply.writer) return writerFailed();
      put({ error: reply.error === "disconnected" ? LOST : String(reply.error) });
    });
    if (!sent) put({ committing: false, error: LOST });
  };
  // A writer failure commits nothing: the line says so and Edit message… opens to type one [D1029, D1212].
  const writerFailed = () => {
    put({ failed: true });
    edit();
  };
  // Typed text first, else the draft written for exactly this commit, filled in only while the field is still empty.
  const edit = () => {
    editingNow.current = message || data.draft || "";
    setEditing(editingNow.current);
    if (live && !message) readDraft((text) => setEditing((now) => (now === "" ? text : now)), () => editingNow.current === "");
  };

  /**
   * The landing move, committing every change first when there are some (`first`): "Merging…" at once, until the
   * step it led to shows; a refusal stays on the line [D30, D1049, D1203]. `text`: a squash's message.
   */
  const go = (verb: "merge" | "squash" | "push" | "sync" | "publish", text: string | null = null, at: StepAt | null = pinned) => {
    if (!step) return;
    const on = step.kind;
    setLanded({ running: true, error: null, on });
    put({ failed: false, error: null });
    if (!live) return void setTimeout(() => setLanded(STILL), 1500);
    if (pending === 0 && (verb === "merge" || verb === "squash")) {
      if (!ops?.land) return setLanded(STILL);
      return ops.land(verb, text, at, (error) => setLanded({ running: false, error: error ? { kind: on, reason: error } : null, on }));
    }
    if (!target || !at) return setLanded({ running: false, error: { kind: on, reason: "Look again." }, on });
    const typed = text ?? saved;
    first(target, [verb, at.head, at.base ?? "-", ...(typed ? ["--message", typed] : [])], (reply) => {
      if (reply.ok) {
        if (saved) setMessage("");
        return refreshStep(true, () => setLanded(STILL));
      }
      if (reply.writer) {
        setLanded(STILL);
        return writerFailed();
      }
      setLanded({ running: false, error: { kind: on, reason: reply.error === "disconnected" ? LOST : String(reply.error) }, on });
      refreshStep(true);
    });
  };
  const mergeLocally = () => {
    if (mergeStyle !== "squash") return go("merge");
    setSquashing(true);
    const at = pinned;
    if (!ops?.squashOf || !at) return;
    setSquashAt(at);
    setSquashCommits(null);
    setSquashMessage("");
    // The writer writes the message; if it can't, it's the commits' own. Until then the user may type one [D1028, D1029].
    let subjects: string | null = null;
    let wrote: boolean | null = null;
    ops.squashOf(at, (squash) => {
      if (!squash) return;
      setSquashCommits(squash.commits.map((each) => ({ ...each, atMs: 0, added: 0, removed: 0 })));
      subjects = squash.message;
      if (wrote === false) setSquashMessage((now) => now || squash.message);
    });
    const sent = writeMessage("squash", false, (reply) => {
      wrote = Boolean(reply.ok);
      const text = reply.ok ? String(reply.text) : subjects;
      if (text) setSquashMessage((now) => now || text);
    });
    if (!sent) wrote = false;
  };
  const run = () => {
    if (!step || working || data.syncing) return;
    if (step.kind === "commit" || step.kind === "folderCommit") commit();
    else if (step.kind === "merge") mergeLocally();
    else if (step.kind === "pushPr" && pending > 0) go("push");
    else if (step.kind === "pushPr" && wired) pr.onPick("pushBranch");
    else if ((step.kind === "sync" || step.kind === "publish") && pending === 0 && ops?.branch) ops.branch[step.kind]();
    else if (step.kind === "sync" || step.kind === "publish") go(step.kind);
    else if (step.kind === "mergePr") setMergingPr(true);
    // Fix with agent and Resolve with agent leave a chip above the composer, sent when the user sends [D1019, D1044]:
    // wired with the composer.
  };

  // Merging from a PR's menu reads as a merge while it runs.
  const shown: Step | null = landing && step && step.kind !== "merge" && step.kind !== "landed" && "base" in step ? { kind: "merge", base: step.base, ready: 0, moved: 0, blocked: null, commit: pending } : step;
  const button: Omit<ComponentProps<typeof ActionButton>, "nowMs"> | null =
    shown && !idle
      ? {
          step: shown,
          // Sync, Publish, Pull only and Push only run through the branch store: the button spins until Rust answers.
          ...((landing || data.syncing) && { running: true }),
          writing: committing,
          disabled: working,
          uncommitted: resolving ? 0 : uncommitted,
          say: working
            ? { line: "Waits for the turn to finish", tone: "quiet" }
            : failed
              ? { line: "Couldn't write a message", tone: "bad" }
              : work.error
                ? { line: `Couldn't commit: ${work.error}`, tone: "bad" }
                : null,
          // The base is behind its own upstream: said, never fast-forwarded [D1187, D1193].
          note: data.freshness?.behind && data.freshness.upstream && "base" in shown ? `${data.freshness.name} is ${data.freshness.behind} behind ${data.freshness.upstream}` : null,
          // Another session working in this folder: the pre-check line says so, and Rust refuses [D1082].
          error: landError ?? data.stepError ?? (data.share?.busy ? { kind: shown.kind, reason: `${data.share.busy} is working in this folder. Wait for its turn to end.` } : null),
          later: landing ? null : later,
          // Pull only and Push only are your own folder's; Rust refuses them in a session's worktree [D1205].
          ...(wired && { can: (pick: ActionPick) => WIRED.includes(pick) && (state?.checkout === "folder" || (pick !== "pullOnly" && pick !== "pushOnly")) }),
          mergeStyle,
          rejected: rejected !== null,
          // Landing is the folder owner's alone [D1082].
          prWay: data.share?.lands === false ? "none" : pr.way,
          onMergeStyle: (style: MergeStyle) => (ops?.setStyle ? ops.setStyle(style) : setOwnStyle(style)),
          onRun: run,
          onPick: (pick: ActionPick) => {
            if (session && pick === "createPr") asked.set(session, id);
            pr.onPick(pick);
            if (pick === "forcePush") target ? askForce(target) : setGalleryForcing(rejected);
            if (pick === "commit") commit();
            if (pick === "editMessage") edit();
            if (pick === "mergeLocally") mergeLocally();
            if ((pick === "pullOnly" || pick === "pushOnly") && target && state?.branch) only(target, pick === "pullOnly" ? "pull-only" : "push-only", state.branch);
          },
        }
      : null;

  const dialogs = (
    <>
      <MessageDialog
        open={editing !== null}
        message={editing ?? ""}
        onMessage={setEditing}
        onCancel={() => setEditing(null)}
        onSave={() => {
          setMessage((editing ?? "").trim());
          setEditing(null);
          put({ failed: false });
        }}
      />
      {step && "base" in step && state && (
        <SquashDialog
          open={squashing}
          branch={state.branch ?? "…"}
          base={step.base}
          commits={squashCommits ?? (ops?.squashOf ? [] : state.commits)}
          pending={pending}
          message={squashMessage}
          onMessage={setSquashMessage}
          onCancel={() => setSquashing(false)}
          onConfirm={() => {
            setSquashing(false);
            go("squash", squashMessage, squashAt);
          }}
        />
      )}
      {step?.kind === "mergePr" && (
        <MergePrDialog open={mergingPr} pr={step.pr} base={step.base} checks={step.checks} onCancel={() => setMergingPr(false)} onConfirm={() => setMergingPr(false)} />
      )}
      {drawsForce && (
        <ForcePushDialog
          force={forcing}
          branch={forcing?.branch ?? "…"}
          onCancel={() => (asking ? cancelForce(asking.target) : setGalleryForcing(null))}
          onConfirm={() => (asking ? forcePush(asking.target) : setGalleryForcing(null))}
        />
      )}
      {drawsPr && pr.dialog}
    </>
  );

  return { prs, locked, button, dialogs };
}
