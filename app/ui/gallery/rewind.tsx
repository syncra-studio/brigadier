// Rewind's confirmation on Fake data [D384, D446, D474]: each case it covers, frozen.
import { RewindForm, type RewindPreview } from "../src/components/thread/rewind";
import { Row, Section } from "./parts";
import { Frozen } from "./project-settings";

const FRAME = "max-w-dialog gap-4 p-5";
const ACTIONS = { onKeep() {}, onRestore() {}, onCancel() {} };
const CASES: [string, RewindPreview][] = [
  ["as it opens", {}],
  ["files can go back", { restore: true }],
  ["files looked at", { restore: true, files: { paths: ["src/totals.ts", "src/invoice.ts"], hand: [], leftOut: [], commits: false } }],
  ["hand edits, big files, commits", { restore: true, files: { paths: ["src/totals.ts"], hand: ["README.md"], leftOut: ["data/dump.sql"], commits: true } }],
  ["no project: keep only", { restore: false, why: "no_project" }],
  ["shared checkout: keep only", { restore: false, why: "shared" }],
  ["refused", { error: "This message can't be rewound to any more." }],
];

export function RewindGallery() {
  return (
    <Section title="Rewind">
      <Row name="Rewind to this message?">
        {CASES.map(([label, preview]) => (
          <Frozen key={label} label={label} frame={FRAME}>
            <RewindForm preview={preview} {...ACTIONS} />
          </Frozen>
        ))}
      </Row>
    </Section>
  );
}
