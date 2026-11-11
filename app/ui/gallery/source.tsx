// The Source panel, the new design [D1200, D1206]: each state beside the summary card's (The mix, D1198) on fake data, then its menus and confirms.
import type { ReactNode } from "react";

import { BRANCHES, CHANGES, CLEAN, COMMITS, COMMITTED, DRAFT, file, FOLDER, GIT_RUNS, HOST, LETTERED, MERGING, PRS, REBASING, STAGED, STEPS, WATCH } from "../src/panel/fake";
import { DiscardDialog, DropStashDialog, GitOutputDialog, StageConflictsDialog } from "../src/panel/source/dialogs";
import { HistoryMenu, MoreButton, PrMenu, SourceHeader } from "../src/panel/source/header";
import { MoreMenu, type Submenu } from "../src/panel/source/more-menu";
import { GitCard } from "../src/panel/card";
import { type SourceData, SourcePanel } from "../src/panel/source/panel";
import { FileList, FileRow } from "../src/panel/source/rows";
import type { Pr, SourceState, Step } from "../src/panel/types";
import { Held, Row, Section, State } from "./parts";
import { PanelFrame } from "./right-panel";

const NOW = Date.now();
const fake = (source: SourceState | null, step: SourceData["step"], more: Partial<SourceData> = {}): SourceData => ({ source, step, host: HOST, branches: BRANCHES, gitRuns: GIT_RUNS, draft: DRAFT, ...more });
const CONFLICT_PRS = [{ ...PRS[0]!, health: "conflicts" as const, failed: 0 }, PRS[1]!];

const MIN = 60_000;
const files = (state: SourceState) => new Set([...state.staged, ...state.changes].map((each) => each.path)).size;
/** Rust's step with what the button commits first [D1203]. */
const first = (step: Step, state: SourceState): Step => ({ ...step, commit: files(state) }) as Step;
const RUNNING: Pr = { ...PRS[0]!, health: "running", failed: 0 };
const PASSED = { command: "pnpm test", exit: 0, atMs: NOW - 3 * MIN, changed: true };
const FAILED_RUN = { command: "cargo test", exit: 101, atMs: NOW - 9 * MIN, changed: false };
const FLAGS = { "package.json": { kind: "manifest", removed: 0, deleted: false }, "src/upload/retry.test.ts": { kind: "test", removed: 12, deleted: false } } as const;
const WITH_FLAGS: SourceState = { ...CHANGES, changes: [...CHANGES.changes, file("package.json", "modified", 1, 1), file("src/upload/retry.test.ts", "modified", 3, 12)] };
const LONG: Step = { ...STEPS.busy, blocked: { why: "busy", folder: "/Users/you/upload-app", files: ["src/upload/client.ts", "src/upload/retry.ts", "src/tray/Progress.tsx"] } };
const LEASE = { branch: "brigadier/912a9469/session", remote: "origin", ref: "refs/heads/brigadier/912a9469/session", remoteRef: "origin/brigadier/912a9469/session", reviewed: "9c41e2a", movedTo: null };

/** The states the owner checks the new design in, Source and the card side by side [D1199, D1206]. */
const PANELS: [string, SourceData, string?][] = [
  ["Agent working, with changes", fake(CHANGES, first(STEPS.merge, CHANGES), { agentWorking: true })],
  ["Needs you: a conflict", fake(MERGING, { ...STEPS.continue, left: 2 }, { prs: CONFLICT_PRS, watch: WATCH })],
  ["Needs you: checks failed", fake(COMMITTED, STEPS.fixPr, { prs: PRS, watch: WATCH, run: FAILED_RUN })],
  ["Needs you: push turned away", fake(COMMITTED, { kind: "sync", branch: LEASE.branch, remote: "origin", behind: 1, ahead: 2, commit: 0 }, { prs: [RUNNING], rejected: LEASE })],
  ["Ready to merge: flagged files, a run", fake(WITH_FLAGS, first(STEPS.merge, WITH_FLAGS), { run: PASSED, flags: FLAGS })],
  ["A PR open, checks running", fake(COMMITTED, { ...STEPS.mergePr, checks: { passed: 4, failed: 0, running: 2, approved: true } }, { prs: [RUNNING], watch: WATCH })],
  ["Your own folder", fake(FOLDER, first(STEPS.sync, FOLDER), { agentPaths: [FOLDER.changes[0]?.path ?? ""] })],
  ["Nothing changed", fake(CLEAN, STEPS.commit)],
  ["Disconnected", fake(CHANGES, first(STEPS.merge, CHANGES), { offline: true, readAtMs: NOW - 4 * MIN })],
  ["A long line: cut, with ⓘ", fake(COMMITTED, LONG)],
  ["Merged: the button stays, off", fake({ ...CLEAN, commits: COMMITS }, STEPS.landed)],
  ["Conflicts resolved: Continue", fake({ ...MERGING, changes: [], staged: [...MERGING.staged, file("src/upload/retry.ts", "modified", 9, 3), file("src/upload/client.ts", "modified", 4, 1)] }, { ...STEPS.continue, left: 0 })],
  ["Rebasing: the stopped commit", fake(REBASING, { ...STEPS.continue, left: 1 })],
  ["Every kind of change", fake(LETTERED, first(STEPS.merge, LETTERED))],
  ["A row selected: its diff shows", fake(STAGED, first(STEPS.merge, STAGED)), "src/upload/client.ts"],
];

const TRUTH = { missing: false, restorable: false, branch: LEASE.branch, head: "9c41e2a7", detached: null, recordedBranch: LEASE.branch, mismatch: false, base: null };
const BLOCKED = (cancelled: number | null): Step => ({ ...STEPS.mergePr, checks: { passed: 4, failed: 0, running: 0, approved: true, cancelled, skipped: 0, blocked: true } });

/** What Rust says about the checkout itself (2.37) [D1187]. */
const TRUTHS: [string, SourceData][] = [
  ["The session's folder is gone: Restore", fake(null, null, { truth: { ...TRUTH, missing: true, restorable: true, branch: null, head: null } })],
  ["Restore refused", fake(null, null, { truth: { ...TRUTH, missing: true, restorable: true, branch: null, head: null }, restoreError: "The branch brigadier/912a9469/session is gone, so the folder can't be made again." })],
  ["Detached HEAD", fake({ ...COMMITTED, branch: null }, STEPS.merge, { truth: { ...TRUTH, branch: null, detached: "9c41e2a" } })],
  ["The branch switched outside the app", fake(COMMITTED, STEPS.merge, { truth: { ...TRUTH, branch: "fix/login", mismatch: true } })],
  ["main behind origin/main, fetched 2 minutes ago", fake(CHANGES, first(STEPS.merge, CHANGES), { freshness: { name: "main", upstream: "origin/main", behind: 3, fetchedAtMs: NOW - 2 * MIN } })],
  ["Checks cancelled on #12", fake(COMMITTED, BLOCKED(1), { prs: [{ ...RUNNING, health: "cancelled" }] })],
  ["Check state unknown on #12", fake(COMMITTED, BLOCKED(null), { prs: [{ ...RUNNING, health: "unknown", failed: null }] })],
];

const DATA: [string, SourceData][] = [
  ["Loading", fake(null, null)],
  ["Couldn't read", fake(null, null, { error: "git exited with 128" })],
  ["Pending: moved at once, waiting for Rust", fake(STAGED, first(STEPS.merge, STAGED), { pending: ["src/upload/client.ts", "README.md"] })],
];

function HeldMenu({ state, sub }: { state: SourceState; sub?: Submenu }) {
  return (
    <Held className="h-112 w-120">
      {(box) => (
        <div className="w-80">
          <SourceHeader>
            <MoreButton locked={false} held menu={<MoreMenu state={state} held={box} {...(sub && { openSub: sub })} />} />
          </SourceHeader>
        </div>
      )}
    </Held>
  );
}

const noop = () => undefined;

export function SourceGallery() {
  return (
    <Section title="Source panel">
      <Row name="Panel states">
        {PANELS.map(([label, data, selected]) => (
          <State key={label} label={label}>
            <div className="flex items-start gap-6">
              <div className="flex w-75 min-w-0 flex-col rounded-overlay bg-popover py-2.5 shadow-raised">
                <GitCard data={data} project="upload-app" nowMs={NOW} />
              </div>
              <PanelFrame className="h-160">
                <SourcePanel data={data} nowMs={NOW} {...(selected && { selected })} />
              </PanelFrame>
            </div>
          </State>
        ))}
      </Row>
      <Row name="The checkout's truth">
        {TRUTHS.map(([label, data]) => (
          <State key={label} label={label}>
            <div className="flex items-start gap-6">
              <div className="flex w-75 min-w-0 flex-col rounded-overlay bg-popover py-2.5 shadow-raised">
                <GitCard data={data} project="upload-app" nowMs={NOW} />
              </div>
              <PanelFrame className="h-160">
                <SourcePanel data={data} nowMs={NOW} />
              </PanelFrame>
            </div>
          </State>
        ))}
      </Row>
      <Row name="Data states">
        {DATA.map(([label, data]) => (
          <State key={label} label={label}>
            <PanelFrame className="h-160">
              <SourcePanel data={data} nowMs={NOW} />
            </PanelFrame>
          </State>
        ))}
      </Row>
      <Row name="The title row's menus">
        <State label="History: the last five commits">
          <Held className="h-96 w-80">
            {(box) => (
              <SourceHeader>
                <HistoryMenu commits={COMMITS} base="main" held={box} />
              </SourceHeader>
            )}
          </Held>
        </State>
        <State label="History: a read that failed, over the last list">
          <Held className="h-96 w-80">
            {(box) => (
              <SourceHeader>
                <HistoryMenu commits={COMMITS.slice(0, 2)} base="main" error="git log: unknown revision main" held={box} />
              </SourceHeader>
            )}
          </Held>
        </State>
        <State label="Pull requests: every PR, the watch">
          <Held className="h-96 w-80">
            {(box) => (
              <SourceHeader>
                <PrMenu prs={PRS} watch={WATCH} nowMs={NOW} held={box} />
              </SourceHeader>
            )}
          </Held>
        </State>
        <State label="Pull requests: one, in conflict">
          <Held className="h-96 w-80">
            {(box) => (
              <SourceHeader>
                <PrMenu prs={CONFLICT_PRS.slice(0, 1)} watch={WATCH} nowMs={NOW} held={box} />
              </SourceHeader>
            )}
          </Held>
        </State>
        <State label="Pull requests: ready, no watch yet">
          <Held className="h-96 w-80">
            {(box) => (
              <SourceHeader>
                <PrMenu prs={[{ ...PRS[0]!, health: "ready", failed: 0 }]} watch={null} nowMs={NOW} held={box} />
              </SourceHeader>
            )}
          </Held>
        </State>
      </Row>
      <Row name="Rows">
        <State label="Hovered" frozen="hover">
          <ul className="w-80">
            <FileRow file={file("src/upload/retry.ts", "modified", 62, 8)} />
          </ul>
        </State>
        <State label="Staged: the ✓">
          <ul className="w-80">
            <FileRow file={file("src/upload/client.ts", "added", 21)} staged />
          </ul>
        </State>
        <State label="Conflicted">
          <ul className="w-80">
            <FileRow file={file("src/upload/retry.ts", "conflicted")} />
          </ul>
        </State>
        <State label="Pending">
          <ul className="w-80">
            <FileRow file={file("src/upload/retry.ts", "modified", 62, 8)} pending />
          </ul>
        </State>
        <State label="Right-click: a file's menu">
          <Held className="h-48 w-80">
            {(box) => (
              <FileList held={box}>
                <FileRow file={file("src/upload/retry.ts", "modified", 62, 8)} />
              </FileList>
            )}
          </Held>
        </State>
        <State label="Right-click: partly staged">
          <Held className="h-48 w-80">
            {(box) => (
              <FileList held={box}>
                <FileRow file={file("src/upload/client.ts", "modified", 25, 3)} staged unstaged />
              </FileList>
            )}
          </Held>
        </State>
        <State label="Right-click: committed, since main">
          <Held className="h-48 w-80">
            {(box) => (
              <FileList held={box}>
                <FileRow file={file("src/upload/retry.test.ts", "added", 42)} committed />
              </FileList>
            )}
          </Held>
        </State>
        <State label="Right-click: a staged file's">
          <Held className="h-48 w-80">
            {(box) => (
              <FileList held={box}>
                <FileRow file={file("src/upload/client.ts", "added", 21)} staged />
              </FileList>
            )}
          </Held>
        </State>
      </Row>
      <Row name="More Actions: a session">
        <State label="Open">
          <HeldMenu state={CHANGES} />
        </State>
        {(["Commit", "Changes", "Branch", "Stash"] as const).map((sub) => (
          <State key={sub} label={sub}>
            <HeldMenu state={CHANGES} sub={sub} />
          </State>
        ))}
        <State label="Commit, during a merge">
          <HeldMenu state={MERGING} sub="Commit" />
        </State>
      </Row>
      <Row name="More Actions: your own folder (it checks out, creates and renames)">
        <State label="Open">
          <HeldMenu state={FOLDER} />
        </State>
        <State label="Branch">
          <HeldMenu state={FOLDER} sub="Branch" />
        </State>
      </Row>
      <Row name="Confirms">
        <Confirm label="Discard a file's changes">
          {(held) => <DiscardDialog discarding={{ scope: "unstaged", files: [file("src/upload/retry.ts", "modified")] }} stagedPaths={new Set()} unstagedPaths={new Set()} held={held} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Discard staged changes">
          {(held) => <DiscardDialog discarding={{ scope: "staged", files: [file("src/upload/client.ts", "modified")] }} stagedPaths={new Set()} unstagedPaths={new Set(["src/upload/client.ts"])} held={held} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Delete an untracked file">
          {(held) => <DiscardDialog discarding={{ scope: "unstaged", files: [file("notes/todo.md", "untracked")] }} stagedPaths={new Set()} unstagedPaths={new Set()} held={held} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Discard many files">
          {(held) => <DiscardDialog discarding={{ scope: "unstaged", files: CHANGES.changes }} stagedPaths={new Set()} unstagedPaths={new Set()} held={held} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Stage with conflicts">
          {(held) => <StageConflictsDialog staging={{ paths: ["src/upload/retry.ts"], marked: 1 }} held={held} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Stage many with conflicts">
          {(held) => <StageConflictsDialog staging={{ paths: ["src/upload/retry.ts", "src/upload/client.ts"], marked: 2 }} held={held} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Drop the latest stash">{(held) => <DropStashDialog open held={held} onCancel={noop} onConfirm={noop} />}</Confirm>
      </Row>
      <Row name="Git Output">
        <Confirm label="Loading" tall>
          {(held) => <GitOutputDialog runs={null} held={held} onClose={noop} />}
        </Confirm>
        <Confirm label="Nothing ran yet" tall>
          {(held) => <GitOutputDialog runs={[]} held={held} onClose={noop} />}
        </Confirm>
        <Confirm label="Runs, a failure in red" tall>
          {(held) => <GitOutputDialog runs={GIT_RUNS} held={held} onClose={noop} />}
        </Confirm>
      </Row>
    </Section>
  );
}

/** A dialog held open in place. */
export function Confirm({ label, tall = false, children }: { label: string; tall?: boolean; children: (held: HTMLElement) => ReactNode }) {
  return (
    <State label={label}>
      <Held className={`${tall ? "h-112 w-200" : "h-80 w-160"} overflow-hidden rounded-surface`}>{children}</Held>
    </State>
  );
}
