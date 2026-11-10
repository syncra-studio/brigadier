// Delete's confirm and the archived thread's bar on Fake data [D35, D180, D181, D198]: each state frozen.
import { ArchivedPage, DeleteForm } from "../src/sessions/archived";
import type { SessionRow } from "../src/sidebar/words";
import { Row, Section, State } from "./parts";
import { Frozen } from "./project-settings";

const ROW: SessionRow = { id: "s-1", title: "Fix the invoice totals", state: "idle", mark: null, resets: null, sent: 0, finished: 0, project: null, archived: 1 };
const FRAME = "max-w-dialog gap-4 p-5";

export function ArchiveGallery() {
  return (
    <Section title="Archive and delete">
      <Row name="Delete session? · checking its branch · nothing to ask · a branch with unlanded work · check failed">
        <Frozen label="checking" frame={FRAME}>
          <DeleteForm row={ROW} onClose={() => {}} check={{ state: "checking" }} />
        </Frozen>
        <Frozen label="merged or no branch" frame={FRAME}>
          <DeleteForm row={ROW} onClose={() => {}} check={{ state: "done", branch: null }} />
        </Frozen>
        <Frozen label="unlanded branch" frame={FRAME}>
          <DeleteForm row={ROW} onClose={() => {}} check={{ state: "done", branch: "brigadier/s-1" }} />
        </Frozen>
        <Frozen label="check failed" frame={FRAME}>
          <DeleteForm row={ROW} onClose={() => {}} check={{ state: "failed", error: "Brigadier isn't running" }} />
        </Frozen>
      </Row>
      <Row name="archived page, in the thread’s place · restoring">
        <State label="archived">
          <ArchivedPage row={ROW} />
        </State>
        <State label="restoring">
          <ArchivedPage row={{ ...ROW, lifecycle: { op: "restore" } }} />
        </State>
      </Row>
    </Section>
  );
}
