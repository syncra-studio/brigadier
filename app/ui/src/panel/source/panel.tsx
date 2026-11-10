import { useEffect, useState } from "react";

import { Button } from "../../components/button";
import { cx } from "../../components/cx";
import { ErrorLine } from "../../components/error-line";
import { Skeleton } from "../../components/skeleton";
import type { Branch, ForcePush, MergeStyle, Pr, PrWatch, SourceFile, SourceState, Step, StepError } from "../types";
import { statusWords } from "../words";
import { ActionButton } from "./action";
import { ForcePushDialog, MergePrDialog, SquashDialog } from "./action-confirms";
import { BranchItem } from "./branch";
import { CommitBox } from "./commit-box";
import { type Discarding, DiscardDialog, DropStashDialog, GitOutputDialog, type GitRun, StageAllDialog, StageConflictsDialog } from "./dialogs";
import { HistoryMenu, MoreButton, PrMenu, SourceHeader } from "./header";
import { MoreMenu } from "./more-menu";
import { BranchNameBox, folderItems, QuickPick, sessionItems } from "./quick-pick";
import { FileRow, Group, Heading } from "./rows";
import { StatusLine } from "./status-line";

/** What the Source panel shows: Rust's, once wired (2.14 on); fake until then. */
export type SourceData = {
  /** Null while the first read is under way. */
  source: SourceState | null;
  step: Step | null;
  /** The read failed: shown over the last read, if any, which stays read-only. */
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
  /** The branch's pull requests and what their watch saw (2.13); none without a host [D1030]. */
  prs?: Pr[];
  watch?: PrWatch | null;
  /** The message drafted for the work so far (2.20), the field's grey text [D1107]. */
  draft?: string | null;
};

const SQUASH_MESSAGE = `Retry failed uploads

Uploads that fail now retry three times with a growing wait, and the tray shows how far each one got.`;

type Picker = "branch" | "rename" | "create" | null;

/** Rust's moves and the tabs a row opens, once wired [D1043, D1103]: without them the panel moves a local copy. */
export type SourceOps = {
  stage: (paths: string[]) => void;
  unstage: (paths: string[]) => void;
  discard: (paths: string[], scope: Discarding["scope"]) => void;
  /** A file's diff in a Review tab, or every file's with none. */
  review: (path?: string) => void;
  openFile: (path: string) => void;
  retry: () => void;
};

/** One entry for a path that is partly staged: its staged and unstaged lines together. */
const sum = (file: SourceFile, other?: SourceFile): SourceFile => (other ? { ...file, added: file.added + other.added, removed: file.removed + other.removed } : file);

/** Messages typed and not committed, by checkout: they outlive the view, as the old CommitBox's did. */
const unsent = new Map<string, string>();

/**
 * The Source panel, direction C [D1098]: the title row with History, PRs and More Actions; one status; the message
 * field, the action button and Review changes; one list of files; the branch item in the footer [D1094, D1111].
 * Unwired: its actions move rows in a local copy, or do nothing [D388]. `selected`: the row whose diff shows.
 */
export function SourcePanel({
  data,
  draftKey,
  nowMs,
  selected,
  picker: initialPicker = null,
  onSource,
  ops,
}: {
  data: SourceData;
  draftKey?: string;
  nowMs: number;
  selected?: string;
  picker?: Picker;
  /** The local copy after each fake move, for the toggle and the Source badge (unwired). */
  onSource?: (source: SourceState) => void;
  ops?: SourceOps;
}) {
  const [local, setLocal] = useState(data.source);
  useEffect(() => {
    if (local && local !== data.source) onSource?.(local);
  }, [local, data.source, onSource]);
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

  const state = ops ? data.source : local;
  const step = data.step;
  const offline = data.offline ?? false;
  const pending = new Set(data.pending ?? []);
  // A watch that failed after its first read: the last read stays, read-only, under the error [D30].
  const stale = state !== null && Boolean(data.error);
  const locked = offline || stale || committing || writing;
  const resolving = state?.merging != null || state?.rebasing != null;
  const conflicted = resolving ? (state?.changes.filter((file) => file.status === "conflicted") ?? []) : [];
  const changes = state?.changes.filter((file) => !conflicted.includes(file)) ?? [];
  const staged = state?.staged ?? [];
  const stagedPaths = new Set(staged.map((file) => file.path));
  // One list [D1110]: a file both staged and changed shows once, with its ✓; by path, as git lists them, so staging moves no row.
  const unstagedPaths = new Set(state?.changes.map((file) => file.path));
  const uncommitted = [...staged.map((file) => sum(file, state?.changes.find((other) => other.path === file.path))), ...(state?.changes.filter((file) => !stagedPaths.has(file.path)) ?? [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const merged = uncommitted.filter((file) => !conflicted.includes(file));
  const listed = uncommitted.length > 0 ? uncommitted : (state?.sinceBase ?? []);
  const clean = state !== null && uncommitted.length === 0 && !resolving;
  // Nothing to commit and nothing further to do: no button.
  const idle = clean && (step?.kind === "commit" || step?.kind === "folderCommit" || step?.kind === "landed");
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
    ops ? ops[to === "staged" ? "stage" : "unstage"](paths) : setLocal((now) => {
      if (!now) return now;
      const [from, into] = to === "staged" ? [now.changes, now.staged] : [now.staged, now.changes];
      // A path already on the other side (partly staged) joins it as one entry.
      const moving = from
        .filter((file) => paths.includes(file.path))
        .map((file): SourceFile => sum(file.status === "conflicted" ? { ...file, status: "modified" } : file, into.find((other) => other.path === file.path)));
      const left = from.filter((file) => !paths.includes(file.path));
      const kept = [...into.filter((file) => !paths.includes(file.path)), ...moving];
      return to === "staged" ? { ...now, changes: left, staged: kept } : { ...now, staged: left, changes: kept };
    });
  // Discarding staged changes loses the path's unstaged ones too, as its confirm says.
  const drop = (files: SourceFile[], scope: Discarding["scope"]) => {
    const paths = files.map((file) => file.path);
    if (ops) return ops.discard(paths, scope);
    const keep = (list: SourceFile[]) => list.filter((file) => !paths.includes(file.path));
    setLocal((now) => now && (scope === "staged" ? { ...now, staged: keep(now.staged), changes: keep(now.changes) } : { ...now, changes: keep(now.changes) }));
  };

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
    // Fix with agent and Resolve with agent leave a chip above the composer, sent when the user sends [D1019, D1044]:
    // wired with the composer.
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

  const top = state && (
    <div className="flex flex-col gap-3">
      <StatusLine status={statusWords(state, step, uncommitted.length, data.prs ?? [])} files={resolving ? uncommitted : listed} />
      {(uncommitted.length > 0 || resolving) && (
        <CommitBox
          message={message}
          onMessage={(next) => {
            setMessage(next);
            setFailed(false);
          }}
          branch={state.branch}
          draft={data.draft ?? null}
          rebaseMessage={state.rebasing?.message ?? null}
          writing={writing}
          busy={committing || writing}
          canWrite={!resolving}
          failed={failed}
          onWrite={write}
          onCommit={commit}
        />
      )}
      {step && !idle && (
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
      )}
      {listed.length > 0 && (
        <Button variant="soft" size="sm" className="self-start" onClick={() => ops?.review()}>
          Review changes
        </Button>
      )}
    </div>
  );

  // A click opens the file's diff in a Review tab, Open File the file in its own tab [D1032, D1103].
  const row = (file: SourceFile, committed = false) => (
    <FileRow
      key={file.path}
      file={file}
      staged={stagedPaths.has(file.path)}
      unstaged={unstagedPaths.has(file.path)}
      committed={committed}
      selected={selected === file.path}
      locked={locked}
      pending={pending.has(file.path)}
      actions={{
        onOpen: () => ops?.review(file.path),
        onOpenFile: () => ops?.openFile(file.path),
        onStage: () => (file.status === "conflicted" ? setStagingConflicts({ paths: [file.path], marked: 1 }) : move([file.path], "staged")),
        onUnstage: () => move([file.path], "changes"),
        onDiscard: () => setDiscarding({ scope: stagedPaths.has(file.path) ? "staged" : "unstaged", files: [file] }),
      }}
    />
  );

  return (
    <div className={cx("relative flex min-h-0 flex-1 flex-col", offline && "opacity-disabled")} inert={offline}>
      <SourceHeader>
        {state && base && state.commits.length > 0 && <HistoryMenu commits={state.commits} base={base} />}
        {(data.prs?.length ?? 0) > 0 && <PrMenu prs={data.prs ?? []} watch={data.watch ?? null} nowMs={nowMs} />}
        <MoreButton locked={locked || state === null} menu={more} />
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
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pt-1 pb-3">
        {state === null && !data.error && (
          <div aria-busy className="flex flex-col gap-2">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-control-md" />
            <Skeleton className="h-control-sm" />
            <Skeleton className="h-control-sm w-3/4" />
          </div>
        )}
        {data.error && (!offline || state === null) && (
          <ErrorLine
            error={`Couldn't read this checkout: ${data.error}`}
            actions={
              <button type="button" onClick={ops?.retry} className="shrink-0 cursor-pointer rounded-control text-link hover:text-link-hover focus-visible:focus-ring">
                Try again
              </button>
            }
          />
        )}
        {top}
        {state && (conflicted.length > 0 ? (
          <div className="flex flex-col gap-1 border-t border-divider pt-2">
            <Heading title="Conflicts" count={conflicted.length} />
            <ul className="flex flex-col">{conflicted.map((file) => row(file))}</ul>
            {merged.length > 0 && (
              <Group title="Merged cleanly" count={merged.length} defaultOpen={false}>
                {merged.map((file) => row(file))}
              </Group>
            )}
          </div>
        ) : listed.length > 0 ? (
          <div className="flex flex-col gap-1 border-t border-divider pt-2">
            <Heading title={uncommitted.length > 0 ? "Files" : `Changed since ${base ?? "the base"}`} count={listed.length} />
            <ul className="flex flex-col">{listed.map((file) => row(file, uncommitted.length === 0))}</ul>
          </div>
        ) : (
          !resolving && <p className="text-xs text-muted-foreground">What the agent changes shows here.</p>
        ))}
      </div>
      {state && (
        <footer className="flex shrink-0 items-center border-t border-divider ps-2 pe-1.5 py-1.5">
          <div className="min-w-0 flex-1">
            <BranchItem state={state} locked={locked} open={picker === "branch"} onBranch={() => setPicker("branch")} />
          </div>
        </footer>
      )}

      <DiscardDialog
        discarding={discarding}
        stagedPaths={stagedPaths}
        unstagedPaths={unstagedPaths}
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
