// Delete's confirm and the archived thread's bar on Fake data [D35, D180, D181, D198]: each state frozen.
import { ArchiveForm } from "../src/sessions/archive";
import { ArchivedPage, DeleteForm } from "../src/sessions/archived";
import type { SessionRow } from "../src/sidebar/words";
import { Row, Section, State } from "./parts";
import { Frozen } from "./project-settings";

const ROW: SessionRow = { id: "s-1", title: "Fix the invoice totals", state: "idle", mark: null, resets: null, sent: 0, finished: 0, project: null, archived: 1 };
const FRAME = "max-w-dialog gap-4 p-5";
const ROW_2: SessionRow = { ...ROW, id: "s-2", title: "Login (fork)", archived: null };
const LIVE: SessionRow = { ...ROW, archived: null };
const LOST = [{ ids: ["s-1"], files: [".env", "notes/todo.md"] }];
const noop = () => {};

export function ArchiveGallery() {
  return (
    <Section title="Archive and delete">
      <Row name="Archive session? · only when it has something to say: agent working · ignored files lost · both, two sessions · couldn't list · check failed">
        <Frozen label="agent working" frame={FRAME}>
          <ArchiveForm rows={[LIVE]} check={{ running: ["s-1"], lost: [] }} onConfirm={noop} onCancel={noop} />
        </Frozen>
        <Frozen label="ignored files lost" frame={FRAME}>
          <ArchiveForm rows={[LIVE]} check={{ running: [], lost: LOST }} onConfirm={noop} onCancel={noop} />
        </Frozen>
        <Frozen label="two sessions sharing a folder, one working" frame={FRAME}>
          <ArchiveForm rows={[LIVE, ROW_2]} check={{ running: ["s-2"], lost: [{ ids: ["s-1", "s-2"], files: [".env"] }] }} onConfirm={noop} onCancel={noop} />
        </Frozen>
        <Frozen label="couldn't list" frame={FRAME}>
          <ArchiveForm rows={[LIVE]} check={{ running: [], lost: [{ ids: ["s-1"], error: "git ls-files: not a git repository" }] }} onConfirm={noop} onCancel={noop} />
        </Frozen>
        <Frozen label="check failed" frame={FRAME}>
          <ArchiveForm rows={[LIVE]} error="Brigadier isn't running" onConfirm={noop} onCancel={noop} />
        </Frozen>
      </Row>
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
        <Frozen label="ignored files lost, agent working" frame={FRAME}>
          <DeleteForm row={ROW} onClose={() => {}} check={{ state: "done", branch: null, running: ["s-1"], lost: LOST }} />
        </Frozen>
        <Frozen label="another session still works in its folder" frame={FRAME}>
          <DeleteForm row={ROW} onClose={() => {}} check={{ state: "done", branch: null, stays: "s-2" }} />
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
