// The card's git confirms [D1028, D1029, D1030, D1034, D1203]: the commit message, Create PR and the rest.
import type { ReactNode } from "react";

import { BRANCH, CHANGES, COMMITS, DRAFT, STEPS } from "../src/panel/fake";
import { ForcePushDialog, MergePrDialog, MessageDialog, SquashDialog } from "../src/panel/source/action-confirms";
import { CreatePrDialog, type HostInfo } from "../src/panel/source/create-pr";
import { Held, Row, Section, State } from "./parts";

const noop = () => undefined;
const TYPED = "Retry failed uploads three times\n\nThe upload client retries with a growing wait.";

const PR_INFO: HostInfo = { host: "GitHub", cli: true, base: "main", branch: BRANCH, title: "Retry failed uploads", body: "- Retry failed uploads\n- Show upload progress in the tray" };
const PR_TEXT = { title: PR_INFO.title, body: PR_INFO.body, draft: false };

/** A dialog held open in place. */
function Confirm({ label, tall = false, children }: { label: string; tall?: boolean; children: (held: HTMLElement) => ReactNode }) {
  return (
    <State label={label}>
      <Held className={`${tall ? "h-112 w-200" : "h-80 w-160"} overflow-hidden rounded-surface`}>{children}</Held>
    </State>
  );
}

export function CommitGallery() {
  return (
    <Section title="Git confirms">
      <Row name="Confirms">
        <Confirm label="Edit message…">{(held) => <MessageDialog open message={DRAFT} held={held} onMessage={noop} onCancel={noop} onSave={noop} />}</Confirm>
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
