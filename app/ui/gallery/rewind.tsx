// Rewind's confirmation on Fake data [D384, D480, D481, D1247]: each case it covers, opened on press.
import { useState } from "react";

import { Button } from "../src/components/button";
import { Dialog, DialogContent } from "../src/components/dialog";
import { RewindForm, type RewindPreview } from "../src/components/thread/rewind";
import { FRAME } from "../src/session/rewind";
import { Row, Section } from "./parts";

const NONE = { paths: [], hand: [], leftOut: [], nested: [], commits: false };
const CASES: [string, RewindPreview][] = [
  ["files can go back", { ...NONE, paths: ["src/totals.ts", "src/invoice.ts"] }],
  ["hand edits, big files, a nested repo, commits", { paths: ["src/totals.ts"], hand: ["README.md"], leftOut: ["data/dump.sql", "vendor/sdk"], nested: ["vendor/sdk"], commits: true }],
  ["nothing can go back: no file line (already as before, no project)", NONE],
  ["nothing can go back: not a git folder (D1247)", { ...NONE, why: "not_git" }],
  ["nothing can go back: the folder is missing (D1247)", { ...NONE, why: "no_folder" }],
  ["nothing can go back: no snapshot of this turn", { ...NONE, why: "missing" }],
  ["nothing can go back: all edited since or too big", { ...NONE, hand: ["README.md"], leftOut: ["data/dump.sql"] }],
  ["keep only: snapshot unreadable", { ...NONE, why: "unreadable" }],
  ["refused", { ...NONE, error: "This message can't be rewound to any more." }],
  ["shared folder: the fork worked during this turn", { ...NONE, sharer: { id: "s-2", now: false } }],
  ["shared folder: the fork works now", { ...NONE, sharer: { id: "s-2", now: true } }],
];

export function RewindGallery() {
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const close = () => setPreview(null);
  return (
    <Section title="Rewind">
      <Row name="Rewind to this message?">
        {CASES.map(([label, each]) => (
          <Button key={label} size="sm" variant="outline" onClick={() => setPreview(each)}>
            {label}
          </Button>
        ))}
      </Row>
      {/* As the session opens it (session/rewind.tsx). */}
      <Dialog open={preview !== null} onOpenChange={(next) => !next && close()}>
        <DialogContent frame={FRAME}>{preview && <RewindForm preview={preview} sharerName="Login (fork)" onKeep={close} onRestore={close} onCancel={close} />}</DialogContent>
      </Dialog>
    </Section>
  );
}
