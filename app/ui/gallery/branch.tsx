// The branch label at Source's top and its quick picks [D1021, D1205]: its states, both lists and the name box.
import { type ReactNode, useRef } from "react";

import { BRANCH, BRANCHES, CHANGES, FOLDER, HOST, MERGING, REBASING } from "../src/panel/fake";
import { BranchLabel } from "../src/panel/source/branch";
import { BranchNameBox, folderItems, type Place, QuickPick, sessionItems } from "../src/panel/source/quick-pick";
import { Held, Row, Section, State } from "./parts";

const NOW = Date.now();
const noop = () => undefined;

function Line({ children }: { children: ReactNode }) {
  return <div className="w-80 rounded-surface border border-border bg-background p-2">{children}</div>;
}

/** A pick below the branch label it opens from; inert, so its field doesn't take the page's focus. */
function Over({ children }: { children: (place: Place) => ReactNode }) {
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <div inert>
      <Held className="flex h-96 w-96 flex-col rounded-surface border border-border bg-background p-2">
        {(held) => (
          <>
            <div ref={anchor} className="flex">
              <BranchLabel state={CHANGES} locked={false} readAtMs={NOW} open />
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
    <Section title="Branch label">
      <Row name="The label">
        <State label="Live (its tip)">
          <Line><BranchLabel state={CHANGES} locked={false} readAtMs={NOW} /></Line>
        </State>
        <State label="Your own folder">
          <Line><BranchLabel state={FOLDER} locked={false} readAtMs={NOW} /></Line>
        </State>
        <State label="A fork here: shared with its source">
          <Line><BranchLabel state={CHANGES} locked={false} readAtMs={NOW} sharedWith="Login" /></Line>
        </State>
        <State label="Merging">
          <Line><BranchLabel state={MERGING} locked={false} readAtMs={NOW} /></Line>
        </State>
        <State label="Rebasing">
          <Line><BranchLabel state={REBASING} locked={false} readAtMs={NOW} /></Line>
        </State>
        <State label="Offline">
          <Line><BranchLabel state={CHANGES} locked offline readAtMs={NOW - 120_000} /></Line>
        </State>
        <State label="Hovered" frozen="hover">
          <Line><BranchLabel state={CHANGES} locked={false} readAtMs={NOW} /></Line>
        </State>
      </Row>
      <Row name="Quick picks">
        <State label="A session: no switching">
          <Over>{(place) => <QuickPick place={place} placeholder="This session works on its own branch" items={sessionItems("main", HOST)} onClose={noop} />}</Over>
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
