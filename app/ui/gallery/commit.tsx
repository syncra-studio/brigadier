// The one button [D1008, D1015, D1019, D1028, D1029, D1034, D1045, D1203, D1207]: every state, menu and confirm.
import type { ReactNode } from "react";

import { BRANCH, CHANGES, COMMITS, DRAFT, STEPS } from "../src/panel/fake";
import { ActionButton } from "../src/panel/source/action";
import { ForcePushDialog, MergePrDialog, MessageDialog, SquashDialog } from "../src/panel/source/action-confirms";
import { CreatePrDialog, type HostInfo } from "../src/panel/source/create-pr";
import type { Step } from "../src/panel/types";
import { Held, Row, Section, State } from "./parts";
import { Confirm } from "./source";

const NOW = Date.now();
const noop = () => undefined;
const TYPED = "Retry failed uploads three times\n\nThe upload client retries with a growing wait.";

/** The button at Source's width. */
function Top({ children }: { children: ReactNode }) {
  return <div className="flex w-80 flex-col gap-2 rounded-surface border border-border bg-background p-2">{children}</div>;
}

const BUTTONS: [string, Step, Partial<Parameters<typeof ActionButton>[0]>?][] = [
  ["3 · Merge into main", STEPS.merge],
  ["4 · main moved, still clean", STEPS.mergeMoved],
  ["5 · Would conflict: Catch up", STEPS.catchUp],
  ["6 · Conflicts left: Resolve with agent", STEPS.continue],
  ["6 · Conflicts resolved: Continue", { ...STEPS.continue, left: 0 }],
  ["7 · main busy in your folder", STEPS.busy],
  ["8 · Merging", STEPS.merge, { running: true }],
  ["9 · Couldn't", STEPS.merge, { error: { kind: "merge", reason: "main moved while merging. Checked again: still clean, try once more." } }],
  ["10 · Landed: stays, off", STEPS.landed],
  ["11 · Push to #12", STEPS.pushPr],
  ["12 · Fix with agent: checks", STEPS.fixPr],
  ["12 · Fix with agent: changes asked", STEPS.fixPrChanges],
  ["13 · Merge #12", STEPS.mergePr],
  ["Your folder · Commit", STEPS.folderCommit],
  ["Your folder · Sync Changes", STEPS.sync],
  ["Your folder · Publish Branch", STEPS.publish],
  ["Your folder · Syncing", STEPS.sync, { running: true }],
];

const MENUS: [string, Step, boolean?][] = [
  ["Merge into main", STEPS.merge],
  ["Catch up", STEPS.catchUp],
  ["Resolve with agent", STEPS.continue],
  ["Continue", { ...STEPS.continue, left: 0 }],
  ["Fix with agent", STEPS.fixPr],
  ["Merge #12", STEPS.mergePr],
  ["Push to #12", STEPS.pushPr],
  ["Your folder: Pull only, Push only", STEPS.sync],
  ["After a rejected push", STEPS.sync, true],
];

const FIRST: [string, Step, Partial<Parameters<typeof ActionButton>[0]>?][] = [
  ["Merge into main", { ...STEPS.merge, commit: 6 }],
  ["Push to #12", { ...STEPS.pushPr, commit: 6 }],
  ["Your folder · Sync Changes", { ...STEPS.sync, commit: 6 }],
  ["Your folder · Publish Branch", { ...STEPS.publish, commit: 6 }],
  ["Committing, then merging", { ...STEPS.merge, commit: 6 }, { running: true }],
  ["Commit only: Committing…", { ...STEPS.merge, commit: 6 }, { writing: true }],
  ["The agent works: waits", { ...STEPS.merge, commit: 6 }, { disabled: true, say: { line: "Waits for the turn to finish", tone: "quiet" } }],
  ["The writer failed: nothing committed", { ...STEPS.merge, commit: 6 }, { say: { line: "Couldn't write a message", tone: "bad" } }],
];

const PR_INFO: HostInfo = { host: "GitHub", cli: true, base: "main", branch: BRANCH, title: "Retry failed uploads", body: "- Retry failed uploads\n- Show upload progress in the tray" };
const PR_TEXT = { title: PR_INFO.title, body: PR_INFO.body, draft: false };

export function CommitGallery() {
  return (
    <Section title="The one button">
      <Row name="Commits first, then lands">
        {FIRST.map(([label, step, more]) => (
          <State key={label} label={label}>
            <Top>
              <ActionButton step={step} nowMs={NOW} uncommitted={6} {...more} />
            </Top>
          </State>
        ))}
        <State label="A long line: cut, with ⓘ">
          <div className="flex w-64 flex-col rounded-surface border border-border bg-background p-2">
            <ActionButton step={{ ...STEPS.mergeMoved, commit: 6 }} nowMs={NOW} uncommitted={6} />
          </div>
        </State>
        <State label="Its arrow: Commit only, Edit message…">
          <Held className="h-72 w-80">{(held) => <ActionButton step={{ ...STEPS.merge, commit: 6 }} nowMs={NOW} uncommitted={6} held={held} />}</Held>
        </State>
        <Confirm label="Edit message…">{(held) => <MessageDialog open message={DRAFT} held={held} onMessage={noop} onCancel={noop} onSave={noop} />}</Confirm>
      </Row>
      <Row name="The action button: every step">
        {BUTTONS.map(([label, step, more]) => (
          <State key={label} label={label}>
            <Top>
              <ActionButton step={step} nowMs={NOW} {...more} />
            </Top>
          </State>
        ))}
      </Row>
      <Row name="Its menus">
        {MENUS.map(([label, step, rejected]) => (
          <State key={label} label={label}>
            <Held className="h-96 w-80">{(held) => <ActionButton step={step} nowMs={NOW} held={held} rejected={rejected ?? false} />}</Held>
          </State>
        ))}
        <State label="No host CLI: Push branch, Open PR page">
          <Held className="h-96 w-80">{(held) => <ActionButton step={STEPS.merge} nowMs={NOW} held={held} prWay="page" />}</Held>
        </State>
        <State label="Unknown host: Push branch only">
          <Held className="h-96 w-80">{(held) => <ActionButton step={STEPS.merge} nowMs={NOW} held={held} prWay="none" />}</Held>
        </State>
        <State label="Host still being read">
          <Held className="h-96 w-80">{(held) => <ActionButton step={STEPS.merge} nowMs={NOW} held={held} prWay="loading" />}</Held>
        </State>
        <State label="Catch up, no host CLI">
          <Held className="h-96 w-80">{(held) => <ActionButton step={STEPS.catchUp} nowMs={NOW} held={held} prWay="page" />}</Held>
        </State>
        <State label="Merge as Squash, picked">
          <Held className="h-96 w-80">{(held) => <ActionButton step={STEPS.merge} nowMs={NOW} held={held} mergeStyle="squash" />}</Held>
        </State>
      </Row>
      <Row name="Confirms">
        <Confirm label="Squash, its message editable" tall>
          {(held) => <SquashDialog open branch={BRANCH} base="main" commits={COMMITS.slice(0, 3)} message={TYPED} onMessage={noop} held={held} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Squash, with files not committed yet" tall>
          {(held) => <SquashDialog open branch={BRANCH} base="main" commits={COMMITS.slice(0, 3)} files={CHANGES.changes.map((each) => each.path)} message={TYPED} onMessage={noop} held={held} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Squash, the message being written" tall>
          {(held) => <SquashDialog open branch={BRANCH} base="main" commits={COMMITS.slice(0, 3)} message="" writing onMessage={noop} held={held} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Merge #12: ready">
          {(held) => <MergePrDialog open pr={12} base="main" checks={STEPS.mergePr.checks} held={held} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Merge #12: not all green">
          {(held) => <MergePrDialog open pr={12} base="main" checks={{ passed: 4, failed: 1, running: 1, approved: false }} held={held} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Create PR: loading" tall>
          {(held) => <CreatePrDialog open info={undefined} text={{ title: "", body: "", draft: false }} held={held} onText={noop} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Create PR: text from the branch (proposed until 2.19's writer)" tall>
          {(held) => <CreatePrDialog open info={PR_INFO} text={PR_TEXT} held={held} onText={noop} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Create PR: creating" tall>
          {(held) => <CreatePrDialog open info={PR_INFO} text={{ ...PR_TEXT, draft: true }} busy="creating" held={held} onText={noop} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Create PR: failed, text kept" tall>
          {(held) => <CreatePrDialog open info={PR_INFO} text={PR_TEXT} error={"The remote's branch has commits this one doesn't, so it refused the push.\n\nTo /tmp/demo/origin.git\n ! [rejected]        brigadier/demo -> brigadier/demo (fetch first)\nerror: failed to push some refs to '/tmp/demo/origin.git'"} held={held} onText={noop} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Create PR: answer lost, checking first" tall>
          {(held) => <CreatePrDialog open info={PR_INFO} text={PR_TEXT} busy="checking" error="Brigadier lost its connection. It checks whether the PR was made before making another." held={held} onText={noop} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Create PR: disconnected" tall>
          {(held) => <CreatePrDialog open info={PR_INFO} text={PR_TEXT} offline held={held} onText={noop} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Create PR: the host couldn't be read" tall>
          {(held) => <CreatePrDialog open info={undefined} text={{ title: "", body: "", draft: false }} error="This session has no base to open a PR into." held={held} onText={noop} onRetry={noop} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Force push with lease">
          {(held) => <ForcePushDialog force={{ branch: BRANCH, remote: "origin", ref: `refs/heads/${BRANCH}`, remoteRef: `origin/${BRANCH}`, reviewed: "9c41e2a", movedTo: null }} branch={BRANCH} held={held} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Force push: the remote moved, asks again">
          {(held) => <ForcePushDialog force={{ branch: BRANCH, remote: "origin", ref: `refs/heads/${BRANCH}`, remoteRef: `origin/${BRANCH}`, reviewed: "9c41e2a", movedTo: "d07b3f1" }} branch={BRANCH} held={held} onCancel={noop} onConfirm={noop} />}
        </Confirm>
      </Row>
    </Section>
  );
}
