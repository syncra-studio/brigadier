// Rewind's choices for the owner [D444, D446]: the action's icon on a user's message, and the confirmation
// as another agent has it and as Brigadier would, each with every case it covers. Once picked, the others go.
import { RewindForm, RewindFormT3, type RewindPreview } from "../src/components/thread/rewind";
import { UserBubble } from "../src/components/thread/message";
import { History, Rewind, Undo } from "../src/icons";
import { Row, Section, State } from "./parts";
import { Frozen } from "./project-settings";

const FRAME = "max-w-dialog gap-4 p-5";
const ACTIONS = { onKeep() {}, onRestore() {}, onCancel() {} };
const FILES = { paths: ["src/totals.ts", "src/invoice.ts"], hand: [], leftOut: [], commits: false };
const CASES: [string, RewindPreview][] = [
  ["as it opens", {}],
  ["files can go back", { restore: true }],
  ["files looked at", { restore: true, files: FILES }],
  ["hand edits, big files, commits", { restore: true, files: { paths: ["src/totals.ts"], hand: ["README.md"], leftOut: ["data/dump.sql"], commits: true } }],
  ["no project: keep only", { restore: false, why: "no_project" }],
  ["shared checkout: keep only", { restore: false, why: "shared" }],
  ["refused", { error: "This message can't be rewound to any more." }],
];
const ICONS = [
  ["Undo (Orca, OpenCode)", <Undo />],
  ["History", <History />],
  ["Rewind", <Rewind />],
] as const;

export function RewindGallery() {
  return (
    <Section title="Rewind">
      <Row name="The action's icon on your message · pick one">
        {ICONS.map(([label, icon]) => (
          <State key={label} label={label} frozen="hover">
            <div className="w-72">
              <UserBubble keep={`rewind-${label}`} text="Ship the thread rows." time={Date.now()} rewind={{ open() {}, icon }} />
            </div>
          </State>
        ))}
      </Row>
      <Row name="A · Another agent's confirmation, closest copy">
        {CASES.map(([label, preview]) => (
          <Frozen key={label} label={label} frame={FRAME}>
            <RewindFormT3 preview={preview} {...ACTIONS} />
          </Frozen>
        ))}
      </Row>
      <Row name="B · Brigadier's: one choice, one Rewind">
        {CASES.map(([label, preview]) => (
          <Frozen key={label} label={label} frame={FRAME}>
            <RewindForm preview={preview} {...ACTIONS} />
          </Frozen>
        ))}
      </Row>
    </Section>
  );
}
