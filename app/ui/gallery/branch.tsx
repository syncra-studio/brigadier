// The branch and sync item and its quick picks [D1020, D1021]: every sync state, both lists and the name box.
import { type ReactNode, useRef } from "react";

import { BRANCH, BRANCHES, CHANGES, CLEAN, FOLDER, HOST, MERGING, REBASING } from "../src/panel/fake";
import { BranchItem } from "../src/panel/source/branch";
import { BranchNameBox, folderItems, type Place, QuickPick, sessionItems } from "../src/panel/source/quick-pick";
import { Held, Row, Section, State } from "./parts";

const NOW = Date.now();
const noop = () => undefined;

function Line({ children }: { children: ReactNode }) {
  return <div className="w-80 rounded-surface border border-border bg-background p-2">{children}</div>;
}

/** A pick above the branch item it opens from; inert, so its field doesn't take the page's focus. */
function Over({ children }: { children: (place: Place) => ReactNode }) {
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <div inert>
      <Held className="flex h-96 w-96 flex-col justify-end rounded-surface border border-border bg-background p-2">
        {(held) => (
          <>
            <div ref={anchor}>
              <BranchItem state={CHANGES} locked={false} open />
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
    <Section title="Branch and sync item">
      <Row name="The item">
        <State label="Published, 2 to push">
          <Line><BranchItem state={CHANGES} locked={false} /></Line>
        </State>
        <State label="1 to pull, 2 to push">
          <Line><BranchItem state={FOLDER} locked={false} /></Line>
        </State>
        <State label="In step">
          <Line><BranchItem state={CLEAN} locked={false} /></Line>
        </State>
        <State label="Never published: the cloud">
          <Line><BranchItem state={{ ...CLEAN, upstream: null }} locked={false} /></Line>
        </State>
        <State label="Syncing">
          <Line><BranchItem state={FOLDER} locked={false} syncing /></Line>
        </State>
        <State label="Merging">
          <Line><BranchItem state={MERGING} locked={false} /></Line>
        </State>
        <State label="Rebasing">
          <Line><BranchItem state={REBASING} locked={false} /></Line>
        </State>
        <State label="Busy: off">
          <Line><BranchItem state={CHANGES} locked /></Line>
        </State>
        <State label="Hovered" frozen="hover">
          <Line><BranchItem state={CHANGES} locked={false} /></Line>
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
