// The card's git confirms [D1028, D1029, D1030, D1034, D1203]: the commit message, Create PR and the rest.
import type { ReactNode } from "react";

import { BRANCH } from "../src/panel/fake";
import { MessageDialog } from "../src/panel/source/action-confirms";
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
        <Confirm label="Type a message…">{(held) => <MessageDialog open message={TYPED} failed held={held} onMessage={noop} onCancel={noop} onSave={noop} />}</Confirm>
        <Confirm label="Create PR: loading" tall>
          {(held) => <CreatePrDialog open info={undefined} text={{ title: "", body: "", draft: false }} held={held} onText={noop} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Create PR: text from the branch (proposed until 2.19's writer)" tall>
          {(held) => <CreatePrDialog open info={PR_INFO} text={PR_TEXT} held={held} onText={noop} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Create PR: creating" tall>
          {(held) => <CreatePrDialog open info={PR_INFO} text={{ ...PR_TEXT, draft: true }} busy="creating" held={held} onText={noop} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Create PR: answer lost, checking first" tall>
          {(held) => <CreatePrDialog open info={PR_INFO} text={PR_TEXT} busy="checking" held={held} onText={noop} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Create PR: disconnected" tall>
          {(held) => <CreatePrDialog open info={PR_INFO} text={PR_TEXT} offline held={held} onText={noop} onCancel={noop} onConfirm={noop} />}
        </Confirm>
        <Confirm label="Create PR: the host couldn't be read" tall>
          {(held) => <CreatePrDialog open info={undefined} text={{ title: "", body: "", draft: false }} error="This session has no base to open a PR into." held={held} onText={noop} onRetry={noop} onCancel={noop} onConfirm={noop} />}
        </Confirm>
      </Row>
    </Section>
  );
}
