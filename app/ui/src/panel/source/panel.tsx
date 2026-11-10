import { useState } from "react";

import { cx } from "../../components/cx";
import { ErrorLine } from "../../components/error-line";
import { Skeleton } from "../../components/skeleton";
import { FileDocument, Minus, Plus, Undo } from "../../icons";
import type { Branch, ForcePush, MergeStyle, SourceFile, SourceState, Step, StepError } from "../types";
import { ActionButton } from "./action";
import { ForcePushDialog, MergePrDialog, SquashDialog } from "./action-confirms";
import { BranchItem } from "./branch";
import { CommitBox } from "./commit-box";
import { type Discarding, DiscardDialog, DropStashDialog, GitOutputDialog, type GitRun, StageAllDialog, StageConflictsDialog } from "./dialogs";
import { SourceActions, SourceHeader } from "./header";
import { MoreMenu } from "./more-menu";
import { BranchNameBox, folderItems, QuickPick, sessionItems } from "./quick-pick";
import { CommitsGroup, FileRow, RowButton, SourceGroup } from "./rows";

/** What the Source panel shows: Rust's, once wired (2.14 on); fake until then. */
export type SourceData = {
  /** Null while the first read is under way. */
  source: SourceState | null;
  step: Step | null;
  /** The read failed (and there is nothing older to show). */
  error?: string | null;
  /** The daemon is out of reach: what was last read shows, read-only. */
  offline?: boolean;
  /** Paths moved at once, waiting for Rust's answer [D30]. */
  pending?: string[];
  host?: string | null;
  branches?: Branch[] | null;
  gitRuns?: GitRun[];
  /** A push was turned away: Force Push is offered, with this lease [D1034, D1049]. */
  rejected?: ForcePush | null;
  stepError?: StepError | null;
  /** The agent is working, so the user's own folder can't switch branches [D1021]. */
  agentWorking?: boolean;
};

const SQUASH_MESSAGE = `Retry failed uploads

Uploads that fail now retry three times with a growing wait, and the tray shows how far each one got.`;

type Picker = "branch" | "rename" | "create" | null;

/** Messages typed and not committed, by checkout: they outlive the view, as the old CommitBox's did. */
const unsent = new Map<string, string>();

/**
 * The Source panel, laid out as the old SourcePanel: the title row, the commit box with the action button and the
 * branch item, then Merge Changes, Staged Changes and Changes, and the session's Commits [D1041]. Unwired: its
 * actions move rows in a local copy, or do nothing [D388]. `selected`: the row whose diff shows.
 */
export function SourcePanel({ data, draftKey, nowMs, selected, picker: initialPicker = null }: { data: SourceData; draftKey?: string; nowMs: number; selected?: string; picker?: Picker }) {
  const [local, setLocal] = useState(data.source);
  const [message, setMessageState] = useState(() => (draftKey && unsent.get(draftKey)) || "");
  const setMessage = (next: string) => {
    setMessageState(next);
    if (!draftKey) return;
    if (next) unsent.set(draftKey, next);
    else unsent.delete(draftKey);
  };
  const [prefilled, setPrefilled] = useState<string | null>(null);
  const [stageAll, setStageAll] = useState<"ask" | "always">("ask");
  const [writing, setWriting] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [mergeStyle, setMergeStyle] = useState<MergeStyle>("merge");
  const [picker, setPicker] = useState<Picker>(initialPicker);
  const [discarding, setDiscarding] = useState<Discarding | null>(null);
  const [stagingConflicts, setStagingConflicts] = useState<{ paths: string[]; marked: number } | null>(null);
  const [droppingStash, setDroppingStash] = useState(false);
  const [askingStageAll, setAskingStageAll] = useState(false);
  const [gitOutput, setGitOutput] = useState<GitRun[] | "closed">("closed");
  const [squashing, setSquashing] = useState(false);
  const [squashMessage, setSquashMessage] = useState(SQUASH_MESSAGE);
  const [mergingPr, setMergingPr] = useState(false);
  const [forcing, setForcing] = useState<ForcePush | null>(null);

  const state = local;
  const step = data.step;
  const offline = data.offline ?? false;
  const pending = new Set(data.pending ?? []);
  const locked = offline || committing || writing;
  const resolving = state?.merging != null || state?.rebasing != null;
  const conflicted = resolving ? (state?.changes.filter((file) => file.status === "conflicted") ?? []) : [];
  const changes = state?.changes.filter((file) => !conflicted.includes(file)) ?? [];
  const staged = state?.staged ?? [];
  const clean = state !== null && staged.length === 0 && state.changes.length === 0 && !resolving;
  const folder = state?.checkout === "folder";
  const base = step && "base" in step ? step.base : null;

  // Git's merge message fills the box unless the user wrote one, as the old CommitBox did.
  const merging = state?.merging ?? null;
  if (merging && merging.message !== prefilled) {
    setPrefilled(merging.message);
    if (!message) setMessage(merging.message);
  } else if (!merging && prefilled !== null) setPrefilled(null);

  // Fake moves, at once: what Rust will confirm by path [D30].
  const move = (paths: string[], to: "staged" | "changes") =>
    setLocal((now) => {
      if (!now) return now;
      const from = to === "staged" ? now.changes : now.staged;
      const moving = from.filter((file) => paths.includes(file.path)).map((file): SourceFile => (file.status === "conflicted" ? { ...file, status: "modified" } : file));
      const left = from.filter((file) => !paths.includes(file.path));
      return to === "staged" ? { ...now, changes: left, staged: [...now.staged, ...moving] } : { ...now, staged: left, changes: [...now.changes, ...moving] };
    });
  const drop = (files: SourceFile[], scope: Discarding["scope"]) =>
    setLocal((now) => now && (scope === "staged" ? { ...now, staged: now.staged.filter((file) => !files.includes(file)) } : { ...now, changes: now.changes.filter((file) => !files.includes(file)) }));

  const commit = () => {
    if (!state || locked || clean) return;
    if (staged.length > 0) return finish();
    if (stageAll === "ask") return setAskingStageAll(true);
    move(changes.map((file) => file.path), "staged");
    finish();
  };
  const finish = () => {
    setFailed(false);
    if (message.trim()) {
      setMessage("");
      setLocal((now) => now && { ...now, staged: [] });
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
    // Fix with agent leaves a chip above the composer, sent when the user sends [D1019]: wired with the composer.
  };

  const more = (
    <MoreMenu
      state={state}
      actions={{
        stageAll: () => move(changes.map((file) => file.path), "staged"),
        unstageAll: () => move(staged.map((file) => file.path), "changes"),
        discardAll: () => setDiscarding({ scope: "unstaged", files: changes }),
        createBranch: () => setPicker("create"),
        renameBranch: () => setPicker("rename"),
        dropStash: () => setDroppingStash(true),
        gitOutput: () => setGitOutput(data.gitRuns ?? []),
      }}
    />
  );

  return (
    <div className={cx("relative flex min-h-0 flex-1 flex-col", offline && "opacity-disabled")} inert={offline}>
      <SourceHeader>
        <SourceActions canCommit={!clean && state !== null} locked={locked || state === null} onCommit={commit} moreMenu={more} />
      </SourceHeader>
      {picker === "branch" && state && (
        <QuickPick
          placeholder={folder ? "Select a branch to switch to" : "This session works on its own branch"}
          items={folder ? folderItems(data.branches ?? null, state.branch, nowMs) : sessionItems(base ?? "main", data.host ?? null)}
          off={folder && data.agentWorking ? "Branches can't switch while the agent is working." : null}
          onPick={(item) => setPicker(item.id === "rename" ? "rename" : item.id === "create" ? "create" : null)}
          onClose={() => setPicker(null)}
        />
      )}
      {(picker === "rename" || picker === "create") && (
        <BranchNameBox
          placeholder={picker === "create" ? "New branch name" : "New name for the branch"}
          hint={picker === "rename" ? `Enter renames ${state?.branch ?? "the branch"}` : `Enter creates it from ${state?.branch ?? "what is checked out"} and switches to it`}
          initial={picker === "rename" ? (state?.branch ?? "") : ""}
          onName={() => setPicker(null)}
          onClose={() => setPicker(null)}
        />
      )}
      {state && step && (
        <div className="flex shrink-0 flex-col gap-2 px-2 pb-1">
          <CommitBox
            message={message}
            onMessage={(next) => {
              setMessage(next);
              setFailed(false);
            }}
            branch={state.branch}
            rebaseMessage={state.rebasing?.message ?? null}
            writing={writing}
            busy={committing || writing}
            canWrite={!resolving && !clean}
            idle={clean}
            failed={failed}
            onWrite={write}
            onCommit={commit}
          />
          <ActionButton
            step={step}
            nowMs={nowMs}
            writing={committing && !message.trim()}
            disabled={writing}
            error={data.stepError ?? null}
            mergeStyle={mergeStyle}
            rejected={data.rejected != null}
            onMergeStyle={setMergeStyle}
            onRun={run}
            onPick={(pick) => {
              if (pick === "forcePush" && data.rejected) setForcing(data.rejected);
              if (pick === "commit") commit();
            }}
          />
          <BranchItem state={state} locked={locked} open={picker === "branch"} onBranch={() => setPicker("branch")} />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {state === null && !data.error && (
          <div aria-busy className="flex flex-col gap-2 p-2">
            <Skeleton className="h-16" />
            <Skeleton className="h-control-sm" />
            <Skeleton className="h-control-sm w-3/4" />
            <Skeleton className="h-control-sm w-1/2" />
          </div>
        )}
        {state === null && data.error && (
          <ErrorLine
            error={`Couldn't read this checkout: ${data.error}`}
            className="p-2"
            actions={
              <button type="button" className="shrink-0 cursor-pointer rounded-control text-link hover:text-link-hover focus-visible:focus-ring">
                Try again
              </button>
            }
          />
        )}
        {clean && <p className="p-2 text-sm text-muted-foreground">Nothing to commit</p>}
        {conflicted.length > 0 && (
          <SourceGroup
            title="Merge Changes"
            count={conflicted.length}
            actions={
              <RowButton tooltip="Stage All Merge Changes" disabled={locked} onClick={() => setStagingConflicts({ paths: conflicted.map((file) => file.path), marked: conflicted.length })}>
                <Plus />
              </RowButton>
            }
          >
            {conflicted.map((file) => (
              <FileRow
                key={`merge:${file.path}`}
                file={file}
                group="merge"
                selected={selected === file.path}
                locked={locked}
                pending={pending.has(file.path)}
                actions={{ onStage: () => setStagingConflicts({ paths: [file.path], marked: 1 }) }}
              />
            ))}
          </SourceGroup>
        )}
        {staged.length > 0 && (
          <SourceGroup
            title="Staged Changes"
            count={staged.length}
            actions={
              <>
                <RowButton tooltip="Open Staged Changes">
                  <FileDocument />
                </RowButton>
                <RowButton tooltip="Unstage All Changes" disabled={locked} onClick={() => move(staged.map((file) => file.path), "changes")}>
                  <Minus />
                </RowButton>
              </>
            }
          >
            {staged.map((file) => (
              <FileRow
                key={`staged:${file.path}`}
                file={file}
                group="staged"
                selected={selected === file.path}
                locked={locked}
                pending={pending.has(file.path)}
                actions={{ onUnstage: () => move([file.path], "changes") }}
              />
            ))}
          </SourceGroup>
        )}
        {state && (changes.length > 0 || staged.length > 0 || resolving) && (
          <SourceGroup
            title="Changes"
            count={changes.length}
            actions={
              changes.length > 0 && (
                <>
                  <RowButton tooltip="Open Changes">
                    <FileDocument />
                  </RowButton>
                  <RowButton tooltip="Discard All Changes" disabled={locked} onClick={() => setDiscarding({ scope: "unstaged", files: changes })}>
                    <Undo />
                  </RowButton>
                  <RowButton tooltip="Stage All Changes" disabled={locked} onClick={() => move(changes.map((file) => file.path), "staged")}>
                    <Plus />
                  </RowButton>
                </>
              )
            }
          >
            {changes.map((file) => (
              <FileRow
                key={`changes:${file.path}`}
                file={file}
                group="changes"
                selected={selected === file.path}
                locked={locked}
                pending={pending.has(file.path)}
                actions={{ onStage: () => move([file.path], "staged"), onDiscard: () => setDiscarding({ scope: "unstaged", files: [file] }) }}
              />
            ))}
          </SourceGroup>
        )}
        {state && state.commits.length > 0 && base && <CommitsGroup commits={state.commits} base={base} nowMs={nowMs} />}
      </div>

      <DiscardDialog
        discarding={discarding}
        unstagedPaths={new Set(changes.map((file) => file.path))}
        onCancel={() => setDiscarding(null)}
        onConfirm={() => {
          if (discarding) drop(discarding.files, discarding.scope);
          setDiscarding(null);
        }}
      />
      <StageConflictsDialog
        staging={stagingConflicts}
        onCancel={() => setStagingConflicts(null)}
        onConfirm={() => {
          if (stagingConflicts) move(stagingConflicts.paths, "staged");
          setStagingConflicts(null);
        }}
      />
      <DropStashDialog open={droppingStash} onCancel={() => setDroppingStash(false)} onConfirm={() => setDroppingStash(false)} />
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
      <GitOutputDialog runs={gitOutput} onClose={() => setGitOutput("closed")} />
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
    </div>
  );
}
