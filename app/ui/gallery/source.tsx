// The Source panel, direction C [D1098, D1111, D1114]: its states on fake data, its menus and its confirms.
import type { ReactNode } from "react";

import { BRANCHES, CHANGES, CLEAN, COMMITS, COMMITTED, DRAFT, file, FOLDER, GIT_RUNS, HOST, LETTERED, MERGING, PRS, REBASING, STAGED, STEPS, WATCH } from "../src/panel/fake";
import { DiscardDialog, DropStashDialog, GitOutputDialog, StageConflictsDialog } from "../src/panel/source/dialogs";
import { HistoryMenu, MoreButton, PrMenu, SourceHeader } from "../src/panel/source/header";
import { MoreMenu, type Submenu } from "../src/panel/source/more-menu";
import { type SourceData, SourcePanel } from "../src/panel/source/panel";
import { FileRow } from "../src/panel/source/rows";
import type { SourceState } from "../src/panel/types";
import { Held, Row, Section, State } from "./parts";
import { PanelFrame } from "./right-panel";

const NOW = Date.now();
const fake = (source: SourceState | null, step: SourceData["step"], more: Partial<SourceData> = {}): SourceData => ({ source, step, host: HOST, branches: BRANCHES, gitRuns: GIT_RUNS, draft: DRAFT, ...more });
const CONFLICT_PRS = [{ ...PRS[0]!, health: "conflicts" as const, failed: 0 }, PRS[1]!];

/** The states the owner checks C in [D1098, D1114], then the rest. */
const PANELS: [string, SourceData, string?][] = [
  ["Nothing changed", fake(CLEAN, STEPS.commit)],
  ["Changes: two staged by hand, #12 failing, #11 merged", fake(STAGED, STEPS.commitWaiting, { prs: PRS, watch: WATCH })],
  ["Ready to merge: everything committed", fake(COMMITTED, STEPS.merge)],
  ["A PR with failing checks", fake(COMMITTED, STEPS.fixPr, { prs: PRS, watch: WATCH })],
  ["A conflict: catching up with main", fake(MERGING, STEPS.continue, { prs: CONFLICT_PRS, watch: WATCH })],
  ["Conflicts resolved: Continue", fake({ ...MERGING, changes: [], staged: [...MERGING.staged, file("src/upload/retry.ts", "modified", 9, 3), file("src/upload/client.ts", "modified", 4, 1)] }, { ...STEPS.continue, left: 0 })],
  ["Local checkout: your own folder", fake(FOLDER, STEPS.folderCommit)],
  ["Local checkout, committed: Sync", fake({ ...FOLDER, staged: [], changes: [] }, STEPS.sync)],
  ["Rebasing: the stopped commit", fake(REBASING, { ...STEPS.continue, left: 1 })],
  ["Landed", fake({ ...CLEAN, commits: COMMITS }, STEPS.landed)],
  ["No draft yet", fake(CHANGES, STEPS.commitWaiting, { draft: null })],
  ["Every kind of change", fake(LETTERED, STEPS.commit)],
  ["A row selected: its diff shows", fake(CHANGES, STEPS.commitWaiting), "src/upload/client.ts"],
];

const DATA: [string, SourceData][] = [
  ["Loading", fake(null, null)],
  ["Couldn't read", fake(null, null, { error: "git exited with 128" })],
  ["Disconnected: last read, read-only", fake(CHANGES, STEPS.commitWaiting, { offline: true })],
  ["Pending: moved at once, waiting for Rust", fake(STAGED, STEPS.commit, { pending: ["src/upload/client.ts", "README.md"] })],
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
            <PanelFrame className="h-160">
              <SourcePanel data={data} nowMs={NOW} {...(selected && { selected })} />
            </PanelFrame>
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
              <ul className="w-80">
                <FileRow file={file("src/upload/retry.ts", "modified", 62, 8)} held={box} />
              </ul>
            )}
          </Held>
        </State>
        <State label="Right-click: partly staged">
          <Held className="h-48 w-80">
            {(box) => (
              <ul className="w-80">
                <FileRow file={file("src/upload/client.ts", "modified", 25, 3)} staged unstaged held={box} />
              </ul>
            )}
          </Held>
        </State>
        <State label="Right-click: committed, since main">
          <Held className="h-48 w-80">
            {(box) => (
              <ul className="w-80">
                <FileRow file={file("src/upload/retry.test.ts", "added", 42)} committed held={box} />
              </ul>
            )}
          </Held>
        </State>
        <State label="Right-click: a staged file's">
          <Held className="h-48 w-80">
            {(box) => (
              <ul className="w-80">
                <FileRow file={file("src/upload/client.ts", "added", 21)} staged held={box} />
              </ul>
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
