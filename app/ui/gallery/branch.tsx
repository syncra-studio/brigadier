// The branch's quick picks, opened from the card's branch row [D1021, D1205]: both lists and the name box.
import { type ReactNode, useRef } from "react";

import { Branch } from "../src/icons";
import { BRANCH, BRANCHES, HOST } from "../src/panel/fake";
import { BranchNameBox, folderItems, type Place, QuickPick, sessionItems } from "../src/panel/source/quick-pick";
import { Line } from "../src/panel/source/rows";
import { Held, Row, Section, State } from "./parts";

const NOW = Date.now();
const noop = () => undefined;

/** A pick below the branch row it opens from; inert, so its field doesn't take the page's focus. */
function Over({ children }: { children: (place: Place) => ReactNode }) {
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <div inert>
      <Held className="flex h-96 w-96 flex-col rounded-surface border border-border bg-background p-2">
        {(held) => (
          <>
            <div ref={anchor} className="flex">
              <Line icon={<Branch />}>{BRANCH}</Line>
            </div>
            {children({ anchor, held })}
          </>
        )}
      </Held>
    </div>
  );
}

export function BranchGallery() {
  return (
    <Section title="Branch quick pick">
      <Row name="Quick picks">
        <State label="A session: no switching">
          <Over>{(place) => <QuickPick place={place} placeholder="This session works on its own branch" items={sessionItems("main", HOST)} search={false} onClose={noop} />}</Over>
        </State>
        <State label="Your own folder">
          <Over>{(place) => <QuickPick place={place} placeholder="Select a branch to switch to" items={folderItems(BRANCHES, "main", NOW)} onClose={noop} />}</Over>
        </State>
        <State label="Off while the agent works">
          <Over>{(place) => <QuickPick place={place} placeholder="Select a branch to switch to" items={folderItems(BRANCHES, "main", NOW)} off="Branches can't switch while the agent is working." onClose={noop} />}</Over>
        </State>
        <State label="Loading">
          <Over>{(place) => <QuickPick place={place} placeholder="Select a branch to switch to" items={null} onClose={noop} />}</Over>
        </State>
        <State label="No match">
          <Over>{(place) => <QuickPick place={place} placeholder="Select a branch to switch to" items={[]} onClose={noop} />}</Over>
        </State>
        <State label="Rename">
          <Over>{(place) => <BranchNameBox place={place} placeholder="New name for the branch" hint={`Enter renames ${BRANCH}`} initial={BRANCH} onClose={noop} />}</Over>
        </State>
      </Row>
    </Section>
  );
}
