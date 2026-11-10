import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "../../components/button";
import { cx } from "../../components/cx";
import { ErrorLine } from "../../components/error-line";
import { Skeleton } from "../../components/skeleton";
import type { Branch, Commit, ForcePush, Pr, PrWatch, SourceFile, SourceState, Step, StepError } from "../types";
import { statusWords } from "../words";
import { ActionButton } from "./action";
import { BranchItem } from "./branch";
import { CommitBox } from "./commit-box";
import { type Discarding, DiscardDialog, DropStashDialog, GitOutputDialog, type GitRun, StageConflictsDialog } from "./dialogs";
import { HistoryMenu, MoreButton, PrMenu, SourceHeader } from "./header";
import { MoreMenu } from "./more-menu";
import { BranchNameBox, folderItems, QuickPick, sessionItems } from "./quick-pick";
import { FileList, FileRow, Group, Heading } from "./rows";
import { StatusLine } from "./status-line";
import { useSourceStep } from "./step";

/** What the Source panel shows: Rust's, once wired (2.14 on); fake until then. */
export type SourceData = {
  /**
   * The History icon's commits from Rust and what its menu opens (2.29) [D1041, D1114]; without it, the fake state's
   * (the gallery). Hidden with no base or no commits.
   */
  history?: { commits: Commit[]; base: string | null; error: string | null; onCommit: (sha: string) => void; onOpen: () => void; onMenu: () => void };
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

/** The checkout couldn't be read: Source's and the summary card's line, with Try again. */
export function ReadError({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <ErrorLine
      error={`Couldn't read this checkout: ${error}`}
      actions={
        <button type="button" onClick={onRetry} className="shrink-0 cursor-pointer rounded-control text-link hover:text-link-hover focus-visible:focus-ring">
          Try again
        </button>
      }
    />
  );
}

/**
 * The Source panel, direction C [D1098]: the title row with History, PRs and More Actions; one status; the message
 * field, the action button and Review changes; one list of files; the branch item in the footer [D1094, D1111].
 * Unwired: its actions move rows in a local copy, or do nothing [D388]. `selected`: the row whose diff shows.
 */
export function SourcePanel({
  data,
  draftKey,
  session = null,
  nowMs,
  selected,
  picker: initialPicker = null,
  onSource,
  ops,
}: {
  data: SourceData;
  draftKey?: string;
  /** The session whose PR the action menu makes through Rust's host module [D1030]; none in the gallery. */
  session?: string | null;
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
  const [picker, setPicker] = useState<Picker>(initialPicker);
  const branchItem = useRef<HTMLDivElement>(null);
  const [discarding, setDiscarding] = useState<Discarding | null>(null);
  const [stagingConflicts, setStagingConflicts] = useState<{ paths: string[]; marked: number } | null>(null);
  const [droppingStash, setDroppingStash] = useState(false);
  const [gitOutput, setGitOutput] = useState<GitRun[] | "closed">("closed");

  const state = ops ? data.source : local;
  const step = data.step;
  const offline = data.offline ?? false;
  // The pickers float outside the panel's inert page: a disconnect closes them.
  useEffect(() => {
    if (offline) setPicker(null);
  }, [offline]);
  const pending = new Set(data.pending ?? []);
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
  const folder = state?.checkout === "folder";
  const base = step && "base" in step ? step.base : null;

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

  const { prs, message, setMessage, writing, committing, failed, setFailed, locked, commit, write, button, dialogs } = useSourceStep({
    data,
    state,
    draftKey,
    session,
    move,
    onCommitted: () => setLocal((now) => now && { ...now, staged: [] }),
  });

  // Git's merge message fills the box unless the user wrote one, as the old CommitBox did; before paint, as it shows.
  const merge = state?.merging?.message ?? null;
  const prefilled = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (merge !== null && merge !== prefilled.current && !message) setMessage(merge);
    prefilled.current = merge;
  }, [merge]);

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
      <StatusLine status={statusWords(state, step, uncommitted.length, prs)} files={resolving ? uncommitted : listed} />
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
      {button && <ActionButton nowMs={nowMs} {...button} />}
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
        {data.history ? (
          (data.history.error || (data.history.base && data.history.commits.length > 0)) && <HistoryMenu {...data.history} />
        ) : (
          state && base && state.commits.length > 0 && <HistoryMenu commits={state.commits} base={base} />
        )}
        {prs.length > 0 && <PrMenu prs={prs} watch={data.watch ?? null} nowMs={nowMs} />}
        <MoreButton locked={locked || state === null} menu={more} />
      </SourceHeader>
      {picker === "branch" && state && (
        <QuickPick
          place={{ anchor: branchItem }}
          placeholder={folder ? "Select a branch to switch to" : "This session works on its own branch"}
          items={folder ? folderItems(data.branches ?? null, state.branch, nowMs) : sessionItems(base ?? "main", data.host ?? null)}
          off={folder && data.agentWorking ? "Branches can't switch while the agent is working." : null}
          onPick={(item) => setPicker(item.id === "rename" ? "rename" : item.id === "create" ? "create" : null)}
          onClose={() => setPicker(null)}
        />
      )}
      {(picker === "rename" || picker === "create") && (
        <BranchNameBox
          place={{ anchor: branchItem }}
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
          <ReadError error={data.error} onRetry={ops?.retry} />
        )}
        {top}
        {state && (conflicted.length > 0 ? (
          <div className="flex flex-col gap-1 border-t border-divider pt-2">
            <Heading title="Conflicts" count={conflicted.length} />
            <FileList>{conflicted.map((file) => row(file))}</FileList>
            {merged.length > 0 && (
              <Group title="Merged cleanly" count={merged.length} defaultOpen={false}>
                {merged.map((file) => row(file))}
              </Group>
            )}
          </div>
        ) : listed.length > 0 ? (
          <div className="flex flex-col gap-1 border-t border-divider pt-2">
            <Heading title={uncommitted.length > 0 ? "Files" : `Changed since ${base ?? "the base"}`} count={listed.length} />
            <FileList>{listed.map((file) => row(file, uncommitted.length === 0))}</FileList>
          </div>
        ) : (
          !resolving && <p className="text-xs text-muted-foreground">What the agent changes shows here.</p>
        ))}
      </div>
      {state && (
        <footer className="flex shrink-0 items-center border-t border-divider ps-2 pe-1.5 py-1.5">
          <div ref={branchItem} className="min-w-0 flex-1">
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
      <GitOutputDialog runs={gitOutput} onClose={() => setGitOutput("closed")} />
      {dialogs}
    </div>
  );
}
