// The summary card [D1014, D1048, D1198]: its data states on fake data, then its frame at each pane width.
import { Button } from "../src/components/button";
import { GitCard } from "../src/panel/card";
import { GitControl } from "../src/panel/control";
import { BRANCH, CHANGES, CLEAN, PRS, STAGED, STEPS } from "../src/panel/fake";
import type { SourceData } from "../src/panel/source/data";
import { SummaryCard, SummaryPane, useCardToggle } from "../src/shell/summary-card";
import { Row, Section, State } from "./parts";

const NOW = Date.now();
const READY = STEPS.changes;
const OPEN = PRS.slice(0, 1);
const LOCAL = { ...CLEAN, upstream: null, sinceBase: CHANGES.changes };
const PUSHED = { ...CLEAN, sinceBase: CHANGES.changes };
const TRUTH = { missing: false, restorable: true, branch: BRANCH, head: "9c41e2a", detached: null, recordedBranch: BRANCH, mismatch: false, base: null };

/** The card's data states [D30]. */
const CARDS: [string, SourceData][] = [
  ["Loading", { source: null, step: null }],
  ["Couldn't read", { source: null, step: null, error: "git exited with 128" }],
  ["Disconnected: Offline · 14:32, read-only", { source: STAGED, step: READY, prs: PRS, offline: true, readAtMs: NOW - 240_000 }],
];

/** The control's states, each from Rust's step: the label is the next step, the arrow's menu each row's reason (2.48) [D1285, D1286, D1287]. */
const CONTROL: [string, SourceData][] = [
  ["Changes: Commit", { source: { ...CHANGES, ahead: 0, upstream: null }, step: STEPS.changes }],
  ["Committed: Push publishes the branch", { source: LOCAL, step: STEPS.committed }],
  ["Pushed: Create PR", { source: PUSHED, step: STEPS.pushed }],
  ["A PR open: a grey Commit, merged in the PR tab", { source: PUSHED, step: STEPS.prOpen, prs: OPEN }],
  ["Pushed from elsewhere: Sync ↓1 ↑1", { source: { ...PUSHED, ahead: 1, behind: 1 }, step: STEPS.sync }],
  ["Sync would conflict: Resolve with agent, pulling the upstream", { source: { ...PUSHED, ahead: 1, behind: 1 }, step: STEPS.syncConflicts }],
  ["main moved: Catch up with main; Push, PR and Merge off", { source: LOCAL, step: STEPS.moved }],
  ["Catch up would conflict: Resolve with agent, merging main", { source: LOCAL, step: STEPS.catchUpConflicts }],
  ["No remote: Merge into main from the menu", { source: { ...LOCAL, remote: null }, step: STEPS.noHost }],
  ["Merged on this machine", { source: { ...PUSHED, sinceBase: [] }, step: STEPS.landed }],
  ["The agent works: off, waiting for the turn", { source: { ...CHANGES, ahead: 0, upstream: null }, step: STEPS.changes, agentWorking: true }],
  ["Your own folder: nothing to land into", { source: { ...CLEAN, checkout: "folder", branch: "main", upstream: "origin/main", ahead: 2 }, step: STEPS.folder }],
];

/** The branch row's lines (2.49, 2.37) [D1082, D1187, D1193]. */
const BRANCH_ROW: [string, SourceData][] = [
  ["Shared: ‹branch› · shared with ‹source›", { source: { ...CHANGES, ahead: 0, upstream: null }, step: STEPS.shared, share: { with: "Fix the login form", busy: null, includes: null, lands: false } }],
  ["Detached", { source: { ...PUSHED, branch: null }, step: null, truth: { ...TRUTH, branch: null, detached: "9c41e2a" } }],
  ["On another branch", { source: { ...PUSHED, branch: "fix/login" }, step: STEPS.pushed, truth: { ...TRUTH, branch: "fix/login", mismatch: true } }],
  ["The folder gone, with Restore", { source: PUSHED, step: STEPS.pushed, truth: { ...TRUTH, missing: true } }],
  ["main behind origin/main", { source: PUSHED, step: STEPS.pushed, freshness: { name: "main", upstream: "origin/main", behind: 3, fetchedAtMs: NOW - 120_000 } }],
  ["A long note: one line, then the InfoTip", { source: LOCAL, step: STEPS.moved, agentWorking: true, freshness: { name: "main", upstream: "origin/main", behind: 3, fetchedAtMs: NOW - 120_000 } }],
];

const cards = (list: [string, SourceData][]) =>
  list.map(([label, data]) => (
    <State key={label} label={label}>
      {/* Its own stacking context, so the card stays under the section's sticky title. */}
      <div className="relative isolate h-72 w-81">
        <SummaryCard shown>
          <GitCard data={data} project="upload-app" nowMs={NOW} />
        </SummaryCard>
      </div>
    </State>
  ));

/** A thread pane with a few rows and a composer, so the frame's layouts show what they move. */
function Pane({ owner, width, label }: { owner: string; width: string; label: string }) {
  const { shown, toggle } = useCardToggle(owner);
  // Scrolls where the window is narrower than the pane, so each keeps the width its layout needs.
  return (
    <div className="max-w-full overflow-x-auto pb-2">
      <State label={label}>
        <div className="flex flex-col items-start gap-2">
          <Button size="sm" variant="soft" onClick={toggle}>
            {shown ? "Hide the card" : "Show the card"}
          </Button>
          <div className={`flex h-120 overflow-hidden rounded-surface border border-border bg-background ${width}`}>
            <SummaryPane owner={owner} card={<GitCard data={{ source: STAGED, step: READY, prs: PRS }} project="upload-app" nowMs={NOW} />}>
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pt-8">
                {["Make failed uploads retry three times with a growing wait.", "Done: uploads retry with a growing wait, capped at 30 seconds, and 4xx errors don't retry.", "Show the progress in the tray too."].map((text, index) => (
                  <p key={text} className={`mx-auto w-full max-w-reading px-6 text-sm ${index % 2 === 0 ? "text-end" : ""}`}>
                    <span className={index % 2 === 0 ? "inline-block rounded-surface bg-muted px-3 py-2 text-start" : ""}>{text}</span>
                  </p>
                ))}
              </div>
              <div className="mx-auto w-full max-w-reading shrink-0 px-4 pb-4">
                <div className="h-24 rounded-surface border border-border bg-card" />
              </div>
            </SummaryPane>
          </div>
        </div>
      </State>
    </div>
  );
}

export function CardGallery() {
  return (
    <Section title="Summary card">
      <Row name="Card states">{cards(CARDS)}</Row>
      <Row name="The control: next step, menu rows grey with their reasons">{cards(CONTROL)}</Row>
      <Row name="The control while a step runs: the kit spinner">
        <State label="Pushing">
          <GitControl step={STEPS.committed} off={null} running="push" onRun={() => {}} />
        </State>
      </Row>
      <Row name="The branch row: picker, ↑↓, +/− opening Review, and the checkout's truth">{cards(BRANCH_ROW)}</Row>
      <Row name="The frame by the pane's width: beside the column, the column moved aside, floating only when asked">
        <Pane owner="gallery-card-beside" width="w-390" label="Wide: beside the thread's column" />
        <Pane owner="gallery-card-shift" width="w-250" label="Narrower: the column moves aside" />
        <Pane owner="gallery-card-float" width="w-180" label="Narrow: hidden until asked, then over the thread; Escape closes it" />
      </Row>
    </Section>
  );
}
