import { type ComponentProps, useEffect, useId, useState, useSyncExternalStore } from "react";

import { commitFiles, useGit, writeMessage } from "../git";
import type { ForcePush, MergeStyle, SourceState, Step, StepError } from "../types";
import { laterWords } from "../words";
import { ActionButton } from "./action";
import { ForcePushDialog, MergePrDialog, SquashDialog } from "./action-confirms";
import type { ActionPick } from "./action-menus";
import { askForce, cancelForce, forcePush, useBranchOp, useForcing } from "./branch-ops";
import { useCreatePr } from "./create-pr";
import { StageAllDialog } from "./dialogs";
import type { SourceData, SourceOps } from "./panel";

/** The picks that run on real data so far: Commit, J's PR ways, landing and Force Push [D1029, D1030, D1034, D1152]. */
const WIRED: ActionPick[] = ["commit", "createPr", "pushBranch", "openPrPage", "mergeLocally", "forcePush"];

const SQUASH_MESSAGE = `Retry failed uploads

Uploads that fail now retry three times with a growing wait, and the tray shows how far each one got.`;

/** Messages typed and not committed, by checkout: they outlive the view, as the old CommitBox's did, and Source and the card share them. */
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

/** A commit or a write under way, and how the last one ended, by checkout: Source and the card show the same [D1143, D1144, D1148]. */
type Work = { committing: boolean; writing: boolean; failed: boolean; error: string | null };
const IDLE: Work = { committing: false, writing: false, failed: false, error: null };
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
export function useSourceStep({ data, state, draftKey, session = null, card = false, ops, move, onCommitted }: {
  data: SourceData;
  state: SourceState | null;
  draftKey?: string;
  session?: string | null;
  card?: boolean;
  ops?: SourceOps;
  move: (paths: string[], to: "staged" | "changes") => void;
  onCommitted?: () => void;
}) {
  const [message, setMessage] = useMessage(draftKey);
  const [stageAll, setStageAll] = useState<"ask" | "always">("ask");
  const [work, put] = useWork(draftKey);
  const { writing, committing, failed } = work;
  const live = ops !== undefined;
  const [ownStyle, setOwnStyle] = useState<MergeStyle>("merge");
  const mergeStyle = data.merge ?? ownStyle;
  const [landing, setLanding] = useState(false);
  const [landError, setLandError] = useState<StepError | null>(null);
  const [askingStageAll, setAskingStageAll] = useState(false);
  const [squashing, setSquashing] = useState(false);
  const [squashMessage, setSquashMessage] = useState(SQUASH_MESSAGE);
  const [mergingPr, setMergingPr] = useState(false);
  const [galleryForcing, setGalleryForcing] = useState<ForcePush | null>(null);
  const pr = useCreatePr(session);
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

  const step = data.step;
  // On real data a step whose click comes later is off, saying so [D1143].
  const wired = ops?.land !== undefined;
  const later = wired && step ? laterWords(step.kind) : null;
  useEffect(() => setLandError(null), [step?.kind]);
  // A PR made or pushed here shows in the button's step at once, not at the next PR read [D1143].
  const prKey = prs.map((each) => `${each.number}:${each.state}`).join();
  useEffect(() => void (wired && ops?.refreshStep?.()), [prKey]);
  // A watch that failed after its first read: the last read stays, read-only, under the error [D30].
  const stale = state !== null && Boolean(data.error);
  const locked = (data.offline ?? false) || stale || committing || writing;
  const resolving = state?.merging != null || state?.rebasing != null;
  const changes = state?.changes.filter((file) => !resolving || file.status !== "conflicted") ?? [];
  const clean = state !== null && state.staged.length === 0 && state.changes.length === 0 && !resolving;
  // Nothing to commit and nothing further to do: no button.
  const idle = clean && (step?.kind === "commit" || step?.kind === "folderCommit" || step?.kind === "landed");

  const commit = () => {
    if (!state || locked || clean) return;
    if (state.staged.length > 0) return finish(false);
    if (stageAll === "ask") return setAskingStageAll(true);
    stageAndFinish();
  };
  // Wired, Rust stages everything with the commit, under one lock, so nothing slips in between.
  const stageAndFinish = () => {
    if (!live) move(changes.map((file) => file.path), "staged");
    finish(true);
  };
  /** Rust's answer to a commit or a write: what failed shows in the field, or on the card's button [D1143, D1144]. */
  const settle = (reply: Record<string, any>, done: () => void) => {
    put({ committing: false, writing: false });
    if (reply.ok) return done();
    if (reply.writer) return put({ failed: true });
    put({ error: reply.error === "disconnected" ? LOST : String(reply.error) });
  };
  const finish = (all: boolean) => {
    const typed = message.trim();
    put({ failed: false, error: null });
    if (live) {
      // A blank field: Rust writes the message for exactly what it commits, or commits nothing [D1029].
      put({ committing: true });
      const sent = commitFiles(all, typed, (reply) =>
        settle(reply, () => {
          if (typed) setMessage("");
          onCommitted?.();
        }),
      );
      if (!sent) put({ committing: false, error: LOST });
      return;
    }
    if (typed) {
      setMessage("");
      onCommitted?.();
      return;
    }
    // The gallery's writer fails, so it asks for one.
    put({ committing: true });
    setTimeout(() => put({ committing: false, failed: true }), 1500);
  };
  const write = () => {
    put({ writing: true, failed: false, error: null });
    if (live) {
      const sent = writeMessage("commit", state !== null && state.staged.length === 0, (reply) => settle(reply, () => setMessage(String(reply.text))));
      if (!sent) put({ writing: false, error: LOST });
      return;
    }
    setTimeout(() => put({ writing: false, failed: true }), 1500);
  };
  /** Lands through Rust: "Merging…" at once, until the step it led to shows; a refusal stays on the line [D30, D1049]. */
  const land = (style: MergeStyle, text: string | null) => {
    if (!ops?.land) return;
    setLanding(true);
    setLandError(null);
    ops.land(style, text, (error) => {
      setLanding(false);
      if (error) setLandError({ kind: "merge", reason: error });
    });
  };
  const mergeLocally = () => {
    if (mergeStyle !== "squash") return land("merge", null);
    setSquashing(true);
    if (!live) return;
    // The writer writes the squash's message, else it's the branch's commits; until it's in, the user may type one [D1028, D1029].
    setSquashMessage("");
    const subjects = () => ops?.squashMessage?.((first) => first !== null && setSquashMessage((now) => now || first));
    writeMessage("squash", false, (reply) => (reply.ok ? setSquashMessage((now) => now || String(reply.text)) : subjects()));
  };
  const run = () => {
    if (!step) return;
    if (step.kind === "commit" || step.kind === "folderCommit") commit();
    else if (step.kind === "merge") mergeLocally();
    else if (step.kind === "pushPr" && wired) pr.onPick("pushBranch");
    else if ((step.kind === "sync" || step.kind === "publish") && ops?.branch) ops.branch[step.kind]();
    else if (step.kind === "mergePr") setMergingPr(true);
    // Fix with agent and Resolve with agent leave a chip above the composer, sent when the user sends [D1019, D1044]:
    // wired with the composer.
  };

  // Merging from a PR's menu reads as a merge while it runs.
  const shown: Step | null = landing && step && step.kind !== "merge" && "base" in step ? { kind: "merge", base: step.base, ready: 0, moved: 0, blocked: null } : step;
  const button: Omit<ComponentProps<typeof ActionButton>, "nowMs"> | null =
    shown && !idle
      ? {
          step: shown,
          ...(landing && { running: true }),
          writing: committing && !message.trim(),
          ...(committing && message.trim() && { running: true }),
          disabled: writing,
          // The field shows Source's own failures; the card has none, so its button's line does.
          error: landError ?? data.stepError ?? (card && (failed || work.error) ? { kind: shown.kind, reason: failed ? "no message was written. Type one in Source." : work.error! } : null),
          later: landing ? null : later,
          ...(wired && { can: (pick: ActionPick) => WIRED.includes(pick) }),
          mergeStyle,
          rejected: rejected !== null,
          prWay: pr.way,
          onMergeStyle: (style: MergeStyle) => (ops?.setStyle ? ops.setStyle(style) : setOwnStyle(style)),
          onRun: run,
          onPick: (pick: ActionPick) => {
            if (session && pick === "createPr") asked.set(session, id);
            pr.onPick(pick);
            if (pick === "forcePush") target ? askForce(target) : setGalleryForcing(rejected);
            if (pick === "commit") commit();
            if (pick === "mergeLocally") mergeLocally();
          },
        }
      : null;

  const dialogs = (
    <>
      <StageAllDialog
        open={askingStageAll}
        onClose={() => setAskingStageAll(false)}
        onAnswer={(answer) => {
          setAskingStageAll(false);
          if (answer === "never") return;
          if (answer === "always") setStageAll("always");
          stageAndFinish();
        }}
      />
      {step && "base" in step && state && (
        <SquashDialog
          open={squashing}
          branch={state.branch ?? "…"}
          base={step.base}
          commits={state.commits}
          message={squashMessage}
          onMessage={setSquashMessage}
          onCancel={() => setSquashing(false)}
          onConfirm={() => {
            setSquashing(false);
            land("squash", squashMessage);
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

  const setFailed = (failed: boolean) => put({ failed, error: null });
  return { prs, message, setMessage, writing, committing, failed, error: work.error, setFailed, locked, commit, write, button, dialogs };
}
