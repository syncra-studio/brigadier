// Last turn and Review's brief (2.30, 2.38, and 2.8's additions): Last turn the default, the strip on top with the
// diff one click below it, both ways that click can be, and every state of the strip, on fake data.
import type { Review, ReviewFile } from "../src/review/types";
import { NOTHING_DONE, read } from "./review-data";
import { Row, Section } from "./parts";
import { Tab, Wide } from "./review";

const minutes = (n: number) => Date.now() - n * 60_000;
const TEST: ReviewFile = {
  path: "src/upload/retry.test.ts", from: null, status: "modified", insertions: 2, deletions: 14, binary: false, staged: false, large: false,
  flag: { kind: "test", removed: 14, deleted: false },
};
const LOCK: ReviewFile = {
  path: "pnpm-lock.yaml", from: null, status: "modified", insertions: 31, deletions: 9, binary: false, staged: false, large: true,
  flag: { kind: "lock", removed: 9, deleted: false },
};
const MANIFEST: ReviewFile = { ...LOCK, path: "package.json", insertions: 1, deletions: 1, large: false, flag: { kind: "manifest", removed: 1, deleted: false } };

/** Last turn as Rust sends it: flagged files first, the two captures, the last run. */
function turn(change: Partial<Review> = {}, flagged = true): Review {
  const { review } = read("last", NOTHING_DONE);
  const files = [...(flagged ? [TEST, LOCK, MANIFEST] : []), ...review.files.map((file) => ({ ...file, flag: null }))];
  return {
    ...review,
    scope: "last",
    files,
    insertions: files.reduce((sum, file) => sum + file.insertions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    turn: { before: "a".repeat(40), after: "b".repeat(40), live: false, missed: false, excluded: [] },
    shared: false,
    run: { command: "pnpm test", exit: 0, at: minutes(3), changed: false },
    ...change,
  };
}
const turnOf = (change: Partial<NonNullable<Review["turn"]>>) => ({ ...turn().turn!, ...change });
const empty = (none: Review["none"]): Review => ({ scope: "last", base: null, files: [], insertions: 0, deletions: 0, none });

export function LastTurnGallery() {
  return (
    <Section title="Last turn and the brief (D1000, D1188)">
      <Row name="Last turn, the default: the brief on top, the diff one click below. Pick one">
        <Wide label="The file list: a file's name opens its diff, Expand all opens them all">
          <Tab scope="last" review={turn()} below="files" />
        </Wide>
        <Wide label='A "Show diff" row under the brief'>
          <Tab scope="last" review={turn()} below="row" />
        </Wide>
      </Row>
      <Row name="The last run, as facts (D74, D1192)">
        <Wide label="Exited 0, nothing proves the files changed since">
          <Tab scope="last" review={turn({}, false)} />
        </Wide>
        <Wide label="Exited 1, and an edit began after it">
          <Tab scope="last" review={turn({ run: { command: "cargo test", exit: 1, at: minutes(12), changed: true } }, false)} />
        </Wide>
        <Wide label="Its CLI reported no exit code">
          <Tab scope="last" review={turn({ run: { command: "cargo test", exit: null, at: minutes(5), changed: false } }, false)} />
        </Wide>
        <Wide label="No test or build run this session">
          <Tab scope="last" review={turn({ run: null }, false)} />
        </Wide>
      </Row>
      <Row name="What Last turn compares, and what it leaves out (D1192, D1078)">
        <Wide label="The turn still running: its start against now">
          <Tab scope="last" review={turn({ turn: turnOf({ live: true }) }, false)} />
        </Wide>
        <Wide label="Its end capture was missed">
          <Tab scope="last" review={turn({ turn: turnOf({ missed: true }) }, false)} />
        </Wide>
        <Wide label="Large files and a nested repo left out">
          <Tab scope="last" review={turn({ turn: turnOf({ excluded: ["assets/demo.mov", "vendor/sdk", "data/dump.sql", "fixtures/big.bin"] }) }, false)} />
        </Wide>
        <Wide label="A folder another session works in">
          <Tab scope="last" review={turn({ shared: true }, false)} />
        </Wide>
      </Row>
      <Row name="Nothing to compare: Rust's reason, never an empty diff (D30)">
        {(["noTurn", "midTurn", "noSnapshot", "notGit", "noProject"] as const).map((why) => (
          <Wide key={why} label={why}>
            <Tab scope="last" review={empty(why)} />
          </Wide>
        ))}
      </Row>
      <Row name="The tab's states, the brief with them (D30)">
        <Wide label="On its way">
          <Tab scope="last" review={null} />
        </Wide>
        <Wide label="Reading again: Refresh spins, the brief and diff stay">
          <Tab scope="last" review={turn()} loading />
        </Wide>
        <Wide label="Couldn't be read: the last one stays under the reason">
          <Tab scope="last" review={turn()} error="git exited with 128: bad object" />
        </Wide>
        <Wide label="Daemon away">
          <Tab scope="last" review={turn()} connected={false} />
        </Wide>
        <Wide label="Uncommitted carries the brief too">
          <Tab scope="uncommitted" review={{ ...turn(), scope: "uncommitted", turn: undefined }} />
        </Wide>
      </Row>
    </Section>
  );
}
