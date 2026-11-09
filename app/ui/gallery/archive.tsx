// Delete's confirm and the archived thread's bar on Fake data [D35, D180, D181, D198]: each state frozen.
import { RewindForm } from "../src/components/thread/rewind";
import { ArchivedBar, DeleteForm } from "../src/sessions/archived";
import type { SessionRow } from "../src/sidebar/words";
import { Row, Section, State } from "./parts";
import { Frozen } from "./project-settings";

const ROW: SessionRow = { id: "s-1", title: "Fix the invoice totals", state: "idle", mark: null, resets: null, sent: 0, finished: 0, project: null, archived: 1 };
const FRAME = "max-w-dialog gap-4 p-5";
const READY = { status: "ready" as const, restore: true, paths: [] as string[], hand: [] as string[], leftOut: [] as string[], commits: false };
const ACTIONS = { onKeep() {}, onRestore() {}, onCancel() {} };

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
      <Row name="Rewind to this message? · checking · can restore · hand edits, big files, commits · keep only · refused">
        <Frozen label="checking" frame={FRAME}>
          <RewindForm preview={{ status: "loading" }} {...ACTIONS} />
        </Frozen>
        <Frozen label="can restore" frame={FRAME}>
          <RewindForm preview={{ ...READY, paths: ["src/totals.ts", "src/invoice.ts"] }} {...ACTIONS} />
        </Frozen>
        <Frozen label="incomplete" frame={FRAME}>
          <RewindForm preview={{ ...READY, paths: ["src/totals.ts"], hand: ["README.md"], leftOut: ["data/dump.sql"], commits: true }} {...ACTIONS} />
        </Frozen>
        <Frozen label="keep only" frame={FRAME}>
          <RewindForm preview={{ ...READY, restore: false, why: "shared" }} {...ACTIONS} />
        </Frozen>
        <Frozen label="refused" frame={FRAME}>
          <RewindForm preview={{ status: "error", error: "This message can't be rewound to any more." }} {...ACTIONS} />
        </Frozen>
      </Row>
      <Row name="archived thread's bar · restoring">
        <State label="archived">
          <ArchivedBar row={ROW} />
        </State>
        <State label="restoring">
          <ArchivedBar row={{ ...ROW, lifecycle: { op: "restore" } }} />
        </State>
      </Row>
    </Section>
  );
}
