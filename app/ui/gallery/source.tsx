// The Source panel [D410, D1037, D1041]: its states on fake data, its menu and its confirms.
import type { ReactNode } from "react";

import { BRANCHES, CHANGES, CLEAN, file, FOLDER, GIT_RUNS, HOST, LETTERED, MERGING, REBASING, STAGED, STEPS } from "../src/panel/fake";
import { DiscardDialog, DropStashDialog, GitOutputDialog, StageConflictsDialog } from "../src/panel/source/dialogs";
import { SourceActions, SourceHeader } from "../src/panel/source/header";
import { MoreMenu, type Submenu } from "../src/panel/source/more-menu";
import { type SourceData, SourcePanel } from "../src/panel/source/panel";
import { CommitsGroup, FileRow } from "../src/panel/source/rows";
import type { SourceState } from "../src/panel/types";
import { Held, Row, Section, State } from "./parts";
import { OldApp, PanelFrame } from "./right-panel";

const NOW = Date.now();
const fake = (source: SourceState | null, step: SourceData["step"], more: Partial<SourceData> = {}): SourceData => ({ source, step, host: HOST, branches: BRANCHES, gitRuns: GIT_RUNS, ...more });

const PANELS: [string, SourceData, string?][] = [
  ["Clean, landed", fake({ ...CLEAN, commits: CHANGES.commits }, STEPS.landed)],
  ["Changes, commits waiting", fake(CHANGES, STEPS.commitWaiting)],
  ["Staged and changes", fake(STAGED, STEPS.commit)],
  ["Merge conflicts", fake(MERGING, STEPS.continue)],
  ["Rebasing", fake(REBASING, STEPS.continue)],
  ["Every letter", fake(LETTERED, STEPS.commit)],
  ["A row selected: its diff shows", fake(CHANGES, STEPS.commitWaiting), "src/upload/client.ts"],
  ["Your own folder", fake(FOLDER, STEPS.sync)],
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
            <SourceActions canCommit locked={false} held moreMenu={<MoreMenu state={state} held={box} {...(sub && { openSub: sub })} />} />
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
            <PanelFrame>
              <SourcePanel data={data} nowMs={NOW} {...(selected && { selected })} />
            </PanelFrame>
          </State>
        ))}
      </Row>
      <Row name="Data states">
        {DATA.map(([label, data]) => (
          <State key={label} label={label}>
            <PanelFrame>
              <SourcePanel data={data} nowMs={NOW} />
            </PanelFrame>
          </State>
        ))}
      </Row>
      <Row name="Rows">
        <State label="Hovered: its actions show" frozen="hover">
          <ul className="w-80">
            <FileRow file={file("src/upload/retry.ts", "modified")} group="changes" />
          </ul>
        </State>
        <State label="Staged, hovered" frozen="hover">
          <ul className="w-80">
            <FileRow file={file("src/upload/client.ts", "added")} group="staged" />
          </ul>
        </State>
        <State label="Conflicted, hovered" frozen="hover">
          <ul className="w-80">
            <FileRow file={file("src/upload/retry.ts", "conflicted")} group="merge" />
          </ul>
        </State>
        <State label="Commits since main">
          <div className="w-80">
            <CommitsGroup commits={CHANGES.commits} base="main" nowMs={NOW} />
          </div>
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
          {(held) => <DiscardDialog discarding={{ scope: "unstaged", files: [file("src/upload/retry.ts", "modified")] }} unstagedPaths={new Set()} held={held} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Discard staged changes">
          {(held) => <DiscardDialog discarding={{ scope: "staged", files: [file("src/upload/client.ts", "modified")] }} unstagedPaths={new Set(["src/upload/client.ts"])} held={held} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Delete an untracked file">
          {(held) => <DiscardDialog discarding={{ scope: "unstaged", files: [file("notes/todo.md", "untracked")] }} unstagedPaths={new Set()} held={held} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Discard many files">
          {(held) => <DiscardDialog discarding={{ scope: "unstaged", files: CHANGES.changes }} unstagedPaths={new Set()} held={held} onCancel={noop} onConfirm={noop} />}
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
      <Row name="Old app">
        <OldApp page="source-panel" />
        <OldApp page="source-menu" />
        <OldApp page="source-rebase" />
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
