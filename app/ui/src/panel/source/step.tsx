import { type ComponentProps, useEffect, useId, useState, useSyncExternalStore } from "react";

import type { ForcePush, MergeStyle, SourceState } from "../types";
import { ActionButton } from "./action";
import { ForcePushDialog, MergePrDialog, SquashDialog } from "./action-confirms";
import type { ActionPick } from "./action-menus";
import { useCreatePr } from "./create-pr";
import { StageAllDialog } from "./dialogs";
import type { SourceData } from "./panel";

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

/** Per session, the view whose Create PR… opened the dialog: its open state is the session's, so one view draws it. */
const asked = new Map<string, string>();

/**
 * Source's next step [D1015]: the action button, the commit it runs and the confirms it asks, one set for Source and
 * the summary card [D1145, D1148], with the branch's PRs and Create PR [D1030]. `session`: whose PR it makes; none in
 * the gallery. `card`: the summary card, which draws Create PR's dialog only when it opened it; Source draws it
 * otherwise. `move`: the files' own move, Rust's or the gallery's local copy. `button` is null
 * while there's no step to show (Rust's step comes with 2.19) or nothing to do.
 */
export function useSourceStep({ data, state, draftKey, session = null, card = false, move, onCommitted }: {
  data: SourceData;
  state: SourceState | null;
  draftKey?: string;
  session?: string | null;
  card?: boolean;
  move: (paths: string[], to: "staged" | "changes") => void;
  onCommitted?: () => void;
}) {
  const [message, setMessage] = useMessage(draftKey);
  const [stageAll, setStageAll] = useState<"ask" | "always">("ask");
  const [writing, setWriting] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [mergeStyle, setMergeStyle] = useState<MergeStyle>("merge");
  const [askingStageAll, setAskingStageAll] = useState(false);
  const [squashing, setSquashing] = useState(false);
  const [squashMessage, setSquashMessage] = useState(SQUASH_MESSAGE);
  const [mergingPr, setMergingPr] = useState(false);
  const [forcing, setForcing] = useState<ForcePush | null>(null);
  const pr = useCreatePr(session);
  const id = useId();
  // shortcut: the host module's one read of the branch's PRs until 2.27's watch sends them in `data.prs`.
  const prs = data.prs ?? pr.prs;
  const claim = session ? asked.get(session) : undefined;
  const drawsPr = claim === id || (claim === undefined && !card);
  useEffect(() => () => void (session && asked.get(session) === id && asked.delete(session)), [session, id]);

  const step = data.step;
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
    if (state.staged.length > 0) return finish();
    if (stageAll === "ask") return setAskingStageAll(true);
    move(changes.map((file) => file.path), "staged");
    finish();
  };
  const finish = () => {
    setFailed(false);
    if (message.trim()) {
      setMessage("");
      onCommitted?.();
      return;
    }
    // A blank box: the message is written at commit [D1029]. Unwired, the writer fails, so it asks for one.
    setCommitting(true);
    setTimeout(() => {
      setCommitting(false);
      setFailed(true);
    }, 1500);
  };
  const write = () => {
    setWriting(true);
    setFailed(false);
    setTimeout(() => {
      setWriting(false);
      setFailed(true);
    }, 1500);
  };
  const run = () => {
    if (!step) return;
    if (step.kind === "commit" || step.kind === "folderCommit") commit();
    else if (step.kind === "merge" && mergeStyle === "squash") setSquashing(true);
    else if (step.kind === "mergePr") setMergingPr(true);
    // Fix with agent and Resolve with agent leave a chip above the composer, sent when the user sends [D1019, D1044]:
    // wired with the composer.
  };

  const button: Omit<ComponentProps<typeof ActionButton>, "nowMs"> | null =
    step && !idle
      ? {
          step,
          writing: committing && !message.trim(),
          disabled: writing,
          error: data.stepError ?? null,
          mergeStyle,
          rejected: data.rejected != null,
          prWay: pr.way,
          onMergeStyle: setMergeStyle,
          onRun: run,
          onPick: (pick: ActionPick) => {
            if (session && pick === "createPr") asked.set(session, id);
            pr.onPick(pick);
            if (pick === "forcePush" && data.rejected) setForcing(data.rejected);
            if (pick === "commit") commit();
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
          move(changes.map((file) => file.path), "staged");
          finish();
        }}
      />
      {step?.kind === "merge" && state && (
        <SquashDialog
          open={squashing}
          branch={state.branch ?? "…"}
          base={step.base}
          commits={state.commits}
          message={squashMessage}
          onMessage={setSquashMessage}
          onCancel={() => setSquashing(false)}
          onConfirm={() => setSquashing(false)}
        />
      )}
      {step?.kind === "mergePr" && (
        <MergePrDialog open={mergingPr} pr={step.pr} base={step.base} checks={step.checks} onCancel={() => setMergingPr(false)} onConfirm={() => setMergingPr(false)} />
      )}
      <ForcePushDialog force={forcing} branch={state?.branch ?? "…"} onCancel={() => setForcing(null)} onConfirm={() => setForcing(null)} />
      {drawsPr && pr.dialog}
    </>
  );

  return { prs, message, setMessage, writing, committing, failed, setFailed, locked, commit, write, button, dialogs };
}
