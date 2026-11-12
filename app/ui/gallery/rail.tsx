import type { Item } from "../src/thread/item";
import { Rail, RailPreview, type Entry } from "../src/thread/rail";
import { Row, Section, State } from "./parts";

const WORDS = ["Add a dark theme", "Why does the build fail on CI?", "Make the sidebar resizable", "Rename the settings rows", "Fix the flaky test", "Ship it"];
const ENTRIES: Entry[] = WORDS.map((text, index) => ({ id: `rail-${index}`, text, index }));
const ITEMS = WORDS.flatMap((text, index): Item[] => [
  { id: `rail-${index}`, turnId: `t${index}`, kind: "message", role: "user", text, streaming: false },
  { id: `rail-${index}-a`, turnId: `t${index}`, kind: "message", role: "assistant", text: `Done: ${text.toLowerCase()}, with the change in **one place** and nothing else touched.`, streaming: false },
] as Item[]);
const go = async () => {};

export function RailGallery() {
  return (
    <Section title="Thread · message rail">
      <Row name="rest · preview · live">
        <State label="rest · two in view">
          <div className="relative h-40 w-24">
            <Rail entries={ENTRIES} items={ITEMS} inView={new Set(["rail-2", "rail-3"])} jumpTo={go} />
          </div>
        </State>
        <State label="preview">
          {/* The card sits right of its tick: here, of the box's left edge. */}
          <div className="w-84">
            <div className="relative h-24 w-0">
              <RailPreview text={WORDS[1]!} reply="Done: the build failed on CI because the cache key changed, with the change in one place." top={48} />
            </div>
          </div>
        </State>
        <State label="live · hover, scrub">
          <div className="relative h-40 w-96">
            <Rail entries={ENTRIES} items={ITEMS} inView={new Set(["rail-5"])} jumpTo={go} />
          </div>
        </State>
      </Row>
    </Section>
  );
}
