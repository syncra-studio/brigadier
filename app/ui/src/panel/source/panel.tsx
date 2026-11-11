import { useEffect, useRef, useState } from "react";

import { Button } from "../../components/button";
import { copyWithToast } from "../../components/copy-button";
import { cx } from "../../components/cx";
import { ErrorLine } from "../../components/error-line";
import { Skeleton } from "../../components/skeleton";
import type { Freshness, StepAt, Truth } from "../git";
import type { Branch, Commit, Flag, ForcePush, LastRun, MergeStyle, Pr, PrWatch, SourceFile, SourceState, Step, StepError } from "../types";
import { flagWords, heroWords } from "../words";
import { ActionButton } from "./action";
import { BranchLabel } from "./branch";
import type { BranchRead } from "./branch-ops";
import { type Discarding, DiscardDialog, DropStashDialog, GitOutputDialog, type GitRun, StageConflictsDialog } from "./dialogs";
import { HistoryMenu, MoreButton, PrMenu, SourceHeader } from "./header";
import { Gone, HeroLine } from "./hero";
import { MoreMenu } from "./more-menu";
import { BranchNameBox, folderItems, QuickPick, sessionItems } from "./quick-pick";
import { Counts, FileList, FileRow, Group, Heading, PrLine, RunLine } from "./rows";
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
  /** How the project lands, from Rust [D1028]; the gallery's own pick without it. */
  merge?: MergeStyle | null;
  /** The commits Rust's step was worked out on: a landing is pinned to them [D1049]. */
  at?: StepAt | null;
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
  /**
   * Others work in this folder too, by name [D1070, D1082]: `with` lands its work, `busy` works there now, `includes`
   * made changes still uncommitted here; `lands` false, no PR or merge from here. Null until Rust's first read.
   */
  share?: { with: string | null; busy: string | null; includes: string | null; lands: boolean } | null;
  /** The session's agent is working: the button waits for its turn [D1208], and the user's own folder can't switch branches [D1021]. */
  agentWorking?: boolean;
  /** When the watch last read the checkout: the branch label's tip, and "Offline · 14:32" [D1205, D1206]. */
  readAtMs?: number | null;
  /** What the checkout really is (2.37) [D1187]; Restore under way, or why it was refused. */
  truth?: Truth | null;
  restoring?: boolean;
  restoreError?: string | null;
  /** The base against its own upstream: "main is 3 behind origin/main" on the line, its fetch age in the label's tip [D1187, D1193]. */
  freshness?: Freshness | null;
  /** The session's last test or build run, from Rust's brief (2.38); none yet, or until it's wired. */
  run?: LastRun | null;
  /** Risky files' flags by path, from Rust's brief (2.38) [D1188, D1213]. */
  flags?: Record<string, Flag>;
  /** In your own folder, the paths the fold's edit steps confirm the agent changed (2.38); unknown until wired [D1192]. */
  agentPaths?: string[] | null;
  /** The branch's pull requests and what their watch saw (2.13); none without a host [D1030]. */
  prs?: Pr[];
  watch?: PrWatch | null;
  /** The message drafted for the work so far (2.20), Edit message…'s first text [D1212]. */
  draft?: string | null;
  /** A sync or publish is under way; the name a rename or switch is moving to, until the watch reads it [D30]. */
  syncing?: boolean;
  naming?: string | null;
};

/** The quick pick or name box open over the branch item: `from`, `base` and `newSession` list branches to pick. */
type Picker = "branch" | "rename" | "create" | "from" | "base" | "newSession" | null;

/** The branch item's moves on Rust's git (2.21) [D1020, D1021]; without them (the gallery) a pick only closes. */
export type BranchOps = {
  read: (done: (read: BranchRead | null) => void) => void;
  sync: () => void;
  publish: () => void;
  rename: (name: string) => void;
  switchTo: (name: string, remote: boolean) => void;
  create: (name: string, from: string | null) => void;
  setBase: (base: string) => void;
  /** Home, to start a session from `base` in this session's project. */
  newSession: (base: string) => void;
  openPage: (url: string) => void;
};

/** Rust's moves and the tabs a row opens, once wired [D1043, D1103]: without them the panel moves a local copy. */
export type SourceOps = {
  stage: (paths: string[]) => void;
  unstage: (paths: string[]) => void;
  discard: (paths: string[], scope: Discarding["scope"]) => void;
  /** A file's diff in a Review tab, or every file's with none. */
  review: (path?: string) => void;
  openFile: (path: string) => void;
  retry: () => void;
  branch?: BranchOps;
  /** Rust's step moves (2.22): landing, the merge style, a squash's first message. Without them the button is the gallery's. */
  land?: (style: MergeStyle, message: string | null, at: StepAt | null, done: (error: string | null) => void) => void;
  setStyle?: (style: MergeStyle) => void;
  squashOf?: (at: StepAt, done: (squash: { message: string; commits: { sha: string; subject: string }[] } | null) => void) => void;
  /** Reads the step again now, the branch's PRs too. */
  refreshStep?: () => void;
  /** Re-creates a session's gone folder from its branch [D180, D1187]. */
  restore?: () => void;
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
 * The Source panel, the new design [D1200, D1206]: the title row with the branch label, History, PRs and More Actions
 * [D1205]; the hero, the state's glyph and sentence over the one button and its line; then Checks and Changes,
 * fixed in place [D1201]. No footer, no message field [D1191, D1205]. Without `ops` its actions move rows in a local
 * copy, or do nothing [D388]. `selected`: the row whose diff shows.
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
  const [picker, setPickerNow] = useState<Picker>(initialPicker);
  // What the quick pick lists, read again each time one opens; undefined while it's read.
  const [read, setRead] = useState<BranchRead | null | undefined>(undefined);
  const [from, setFrom] = useState<string | null>(null);
  const branchOps = ops?.branch;
  const setPicker = (next: Picker) => {
    setPickerNow(next);
    if (!next || next === "create" || !branchOps) return;
    setRead(undefined);
    // A read that failed has said why: the pick closes rather than load for ever.
    branchOps.read((answer) => (answer ? setRead(answer) : setPickerNow(null)));
  };
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

  const { prs, locked, button, dialogs } = useSourceStep({ data, state, draftKey, session, ops });
  const flags = data.flags ?? {};
  // Conflicts first, then flagged files, then the rest [D1188, D1201].
  const ordered = (files: SourceFile[]) => [...files].sort((one, other) => Number(!flags[one.path]) - Number(!flags[other.path]));

  const more = (
    <MoreMenu
      state={state}
      actions={{
        stageAll: () => move(changes.map((file) => file.path), "staged"),
        unstageAll: () => move(staged.map((file) => file.path), "changes"),
        discardAll: () => setDiscarding({ scope: "unstaged", files: changes }),
        checkout: () => setPicker("branch"),
        createBranch: () => {
          setFrom(null);
          setPicker("create");
        },
        createFrom: () => setPicker("from"),
        renameBranch: () => setPicker("rename"),
        publish: branchOps?.publish,
        dropStash: () => setDroppingStash(true),
        gitOutput: () => setGitOutput(data.gitRuns ?? []),
      }}
    />
  );

  const hero = state && heroWords(state, step, { files: uncommitted.length, working: data.agentWorking ?? false, rejected: data.rejected != null, open: prs.find((pr) => pr.state === "open")?.number ?? null });
  const added = listed.reduce((sum, file) => sum + file.added, 0);
  const removed = listed.reduce((sum, file) => sum + file.removed, 0);
  // Source's hero [D1200, D1206]: the state's glyph, one sentence, the counts and what's uncommitted; then the button.
  const top = state && hero && (
    <div className="flex flex-col gap-4">
      <HeroLine hero={hero}>
        {listed.length > 0 ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
            {(added > 0 || removed > 0) && <Counts added={added} removed={removed} />}
            {uncommitted.length > 0 && <span>· {uncommitted.length} uncommitted</span>}
          </span>
        ) : (
          !resolving && <span className="text-xs text-muted-foreground">What the agent changes shows here.</span>
        )}
      </HeroLine>
      {button && <ActionButton nowMs={nowMs} {...button} />}
    </div>
  );

  // A click opens the file's diff in a Review tab, Open File the file in its own tab [D1032, D1103].
  const row = (file: SourceFile, committed = false) => (
    <FileRow
      key={file.path}
      file={file}
      fact={flags[file.path] ? flagWords(flags[file.path]!) : null}
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

  const truth = data.truth ?? null;
  const gone = truth?.missing ?? false;
  const label = state && !gone && (
    <div ref={branchItem} className="flex min-w-0">
      <BranchLabel
        state={data.naming ? { ...state, branch: data.naming } : state}
        locked={locked}
        offline={offline}
        readAtMs={data.readAtMs ?? null}
        detached={truth?.detached ?? null}
        {...(data.freshness && { fetchedAtMs: data.freshness.fetchedAtMs })}
        sharedWith={data.share?.with ?? null}
        open={picker === "branch"}
        onBranch={() => setPicker("branch")}
      />
    </div>
  );
  const review = (
    <Button size="inline" variant="link-blue" onClick={() => ops?.review()}>
      Review
    </Button>
  );
  // In your own folder the agent's files and the rest are listed apart, once Rust says which are the agent's [D1192, D1213].
  const agentPaths = folder && data.agentPaths ? new Set(data.agentPaths) : null;
  const theirs = agentPaths ? merged.filter((file) => agentPaths.has(file.path)) : listed;
  const others = agentPaths ? merged.filter((file) => !agentPaths.has(file.path)) : [];

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <SourceHeader label={label}>
        <span className={cx("flex shrink-0 items-center gap-0.5", offline && "opacity-disabled")} inert={offline}>
          {data.history ? (
            (data.history.error || (data.history.base && data.history.commits.length > 0)) && <HistoryMenu {...data.history} />
          ) : (
            state && base && state.commits.length > 0 && <HistoryMenu commits={state.commits} base={base} />
          )}
          {prs.length > 0 && <PrMenu prs={prs} watch={data.watch ?? null} nowMs={nowMs} />}
          <MoreButton locked={locked || state === null} menu={more} />
        </span>
      </SourceHeader>
      {/* The agent or a terminal switched the branch: said in one line [D1187]. */}
      {truth?.mismatch && !truth.detached && (
        <p className="truncate px-3 pb-1 text-xs text-warning">
          On {truth.branch}, not {truth.recordedBranch}
        </p>
      )}
      {picker === "branch" && state && (
        <QuickPick
          place={{ anchor: branchItem }}
          placeholder={folder ? "Select a branch to switch to" : "This session works on its own branch"}
          items={folder ? folderItems(read === undefined && branchOps ? null : (read?.branches ?? data.branches ?? null), state.branch, nowMs) : sessionItems(read?.base ?? base ?? "main", read ? (read.page && read.host) : (data.host ?? null))}
          off={folder && (data.agentWorking || read?.working) ? "Branches can't switch while the agent is working." : null}
          onPick={(item) => {
            setPicker(null);
            if (item.id === "rename") setPicker("rename");
            else if (item.id === "create") {
              setFrom(null);
              setPicker("create");
            } else if (item.id === "createFrom") setPicker("from");
            else if (item.id === "lands") setPicker("base");
            else if (item.id === "new") setPicker("newSession");
            else if (item.id === "copy" && state.branch) copyWithToast(state.branch, "branch name");
            else if (item.id === "open" && read?.page) branchOps?.openPage(read.page);
            else if (folder) branchOps?.switchTo(item.title, item.id.startsWith("true:"));
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {(picker === "from" || picker === "base" || picker === "newSession") && state && (
        <QuickPick
          place={{ anchor: branchItem }}
          placeholder={picker === "from" ? "Select a ref to create the branch from" : picker === "base" ? `What ${state.branch ?? "this branch"} lands into` : "Select a branch to start a session from"}
          // The branches but the checked-out one, as the folder's list has them; Home starts a session from a local one.
          // The base it lands into now is marked in the row's description, as VS Code marks the current item.
          items={read === undefined && branchOps ? null : (folderItems((read?.branches ?? data.branches ?? []).filter((each) => picker !== "newSession" || !each.remote), state.branch, nowMs)?.slice(2).map((item) => (picker === "base" && item.title === (read?.base ?? base) ? { ...item, hint: `current · ${item.hint}` } : item)) ?? null)}
          onPick={(item) => {
            setPicker(null);
            if (picker === "from") {
              setFrom(item.title);
              setPickerNow("create");
            } else if (picker === "base") branchOps?.setBase(item.title);
            else branchOps?.newSession(item.title);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {(picker === "rename" || picker === "create") && (
        <BranchNameBox
          place={{ anchor: branchItem }}
          placeholder={picker === "create" ? "New branch name" : "New name for the branch"}
          hint={picker === "rename" ? `Enter renames ${state?.branch ?? "the branch"}${read?.prs?.length ? " · The PR stays on the old name" : ""}` : `Enter creates it from ${from ?? state?.branch ?? "what is checked out"} and switches to it`}
          initial={picker === "rename" ? (state?.branch ?? "") : ""}
          onName={(name) => {
            setPicker(null);
            if (picker === "rename") branchOps?.rename(name);
            else branchOps?.create(name, from);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      <div className={cx("flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-3", offline && "opacity-disabled")} inert={offline}>
        {gone && <Gone data={data} onRestore={ops?.restore} />}
        {state === null && !data.error && !gone && (
          <div aria-busy className="flex flex-col items-center gap-2 pt-5">
            <Skeleton className="size-8 rounded-capsule" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-control-sm w-full" />
          </div>
        )}
        {data.error && !gone && (!offline || state === null) && <ReadError error={data.error} onRetry={ops?.retry} />}
        {!gone && top}
        {state && !gone && step && (data.run || prs.length > 0) && (
          <section className="flex flex-col">
            <Heading title="Checks" />
            {data.run && <RunLine run={data.run} nowMs={nowMs} />}
            {prs.map((pr) => <PrLine key={pr.number} pr={pr} />)}
          </section>
        )}
        {state && !gone && conflicted.length > 0 && (
          <section className="flex flex-col">
            <Heading title="Conflicts" count={conflicted.length} end={review} />
            <FileList>{conflicted.map((file) => row(file))}</FileList>
            {merged.length > 0 && (
              <Group title="Merged cleanly" count={merged.length} defaultOpen={false}>
                {ordered(merged).map((file) => row(file))}
              </Group>
            )}
          </section>
        )}
        {state && !gone && conflicted.length === 0 && theirs.length > 0 && (
          <section className="flex flex-col">
            <Heading title={agentPaths ? "From the agent" : uncommitted.length > 0 ? "Changes" : `Changed since ${base ?? "the base"}`} count={theirs.length} end={review} />
            <FileList>{ordered(theirs).map((file) => row(file, uncommitted.length === 0))}</FileList>
          </section>
        )}
        {state && !gone && conflicted.length === 0 && others.length > 0 && (
          <section className="flex flex-col">
            <Heading title="Other changes" count={others.length} />
            <FileList>{ordered(others).map((file) => row(file))}</FileList>
          </section>
        )}
      </div>

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
