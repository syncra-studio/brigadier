// Rewind's confirmation on Fake data [D384, D480, D481]: each case it covers, frozen.
import { RewindForm, type RewindPreview } from "../src/components/thread/rewind";
import { FRAME } from "../src/session/rewind";
import { Row, Section } from "./parts";
import { Frozen } from "./project-settings";

const ACTIONS = { onKeep() {}, onRestore() {}, onCancel() {} };
const NONE = { paths: [], hand: [], leftOut: [], nested: [], commits: false };
const CASES: [string, RewindPreview][] = [
  ["files can go back", { ...NONE, paths: ["src/totals.ts", "src/invoice.ts"] }],
  ["hand edits, big files, a nested repo, commits", { paths: ["src/totals.ts"], hand: ["README.md"], leftOut: ["data/dump.sql", "vendor/sdk"], nested: ["vendor/sdk"], commits: true }],
  ["nothing can go back: no file line (already as before, no git, no snapshot, no project)", NONE],
  ["nothing can go back: all edited since or too big", { ...NONE, hand: ["README.md"], leftOut: ["data/dump.sql"] }],
  ["keep only: snapshot unreadable", { ...NONE, why: "unreadable" }],
  ["refused", { ...NONE, error: "This message can't be rewound to any more." }],
  ["shared folder: the fork worked during this turn", { ...NONE, sharer: { id: "s-2", now: false } }],
  ["shared folder: the fork works now", { ...NONE, sharer: { id: "s-2", now: true } }],
];

export function RewindGallery() {
  return (
    <Section title="Rewind">
      <Row name="Rewind to this message?">
        {CASES.map(([label, preview]) => (
          <Frozen key={label} label={label} frame={FRAME}>
            <RewindForm preview={preview} sharerName="Login (fork)" {...ACTIONS} />
          </Frozen>
        ))}
      </Row>
    </Section>
  );
}
