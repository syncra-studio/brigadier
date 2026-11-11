// Messages between sessions, drawn on fake data, as the old app had them [D3014]: the sender's rows, the receiver's
// captioned bubble and queued row, the hop limit's row [D2034], and the composer's "To ‹name›" chip [D3013].
import { type ReactNode, useState } from "react";

import { ComposerPill } from "../src/components/composer/composer";
import { Tooltip, TooltipContent, TooltipTrigger } from "../src/components/tooltip";
import { FromPeer, PeerMessageBlock } from "../src/peers/message";
import { HopStopRow, PeerRefusedRow, PeerSentRow, SessionSentRow, SessionWaitRow } from "../src/peers/rows";
import type { PeerRef } from "../src/peers/words";
import { WorkerGlyph } from "../src/icons/worker-glyphs";
import { ToWorkerChip } from "../src/workers/to-chip";
import { Row, Section, State } from "./parts";
import { RETRY } from "./workers";

const NOW = Date.now();
const noop = () => {};

const DOCS: PeerRef = { session: "s-docs", title: "Docs site: API page", message: "m-1" };
const NOTES: PeerRef = { session: "s-notes", title: "Release notes 0.9", message: "m-2" };
const GONE: PeerRef = { session: "s-gone", title: "a session", gone: true };
const MESSAGE = "The upload endpoint now retries 5 times with backoff; does the API page need changing?\nIts errors table may say otherwise.";
const REPLY = "Yes: the **Errors** table says uploads never retry. I've changed it to list the 5 retries and that a 4xx stops at once.";

function Column({ children }: { children: ReactNode }) {
  return <div className="flex w-140 min-w-0 flex-col gap-2">{children}</div>;
}

/** The To chip with its tip held open under it. */
function HeldTo() {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setBox} className="relative flex min-w-48 pb-12">
      {box && (
        <Tooltip open>
          <TooltipTrigger render={<ComposerPill aria-pressed className="max-w-48" />}>
            <WorkerGlyph id={RETRY.id} />
            <span className="truncate">To {RETRY.name}</span>
          </TooltipTrigger>
          <TooltipContent side="bottom" container={box} collisionAvoidance={{ side: "none", align: "none" }}>
            Send to this session instead
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export function PeersGallery() {
  const [to, setTo] = useState(true);
  const [sent, setSent] = useState(false);
  return (
    <>
      <Section title="Messages between sessions: the sender">
        <Row name="Its own brigadier send">
          <Column>
            <SessionSentRow to={DOCS} state="sending" />
            <SessionSentRow to={DOCS} state="sent" text={MESSAGE} />
            <SessionSentRow to={DOCS} state="declined" />
            <SessionSentRow to={DOCS} state="refused" refused="That session was deleted." />
            <SessionSentRow to={GONE} state="sent" text={MESSAGE} />
          </Column>
        </Row>
        <Row name="Its messages and waits for the replies">
          <Column>
            <PeerSentRow exchange={{ sends: [{ ...DOCS, state: { type: "pending" } }], waits: [], received: [], waitingOn: [] }} />
            <PeerSentRow exchange={{ sends: [{ ...DOCS, state: { type: "delivered" } }], waits: ["inProgress"], received: [], waitingOn: [DOCS] }} />
            <PeerSentRow exchange={{ sends: [{ ...DOCS, state: { type: "replied" } }, { ...NOTES, state: { type: "delivered" } }], waits: ["inProgress"], received: [], waitingOn: [DOCS, NOTES] }} />
            <PeerSentRow exchange={{ sends: [{ ...DOCS, state: { type: "replied" } }], waits: ["completed"], received: [DOCS], waitingOn: [] }} />
            <PeerSentRow exchange={{ sends: [{ ...DOCS, state: { type: "delivered" } }], waits: [], received: [], waitingOn: [] }} />
            <PeerSentRow exchange={{ sends: [{ ...DOCS, state: { type: "delivered" } }], waits: ["completed"], received: [], waitingOn: [] }} />
            <PeerSentRow exchange={{ sends: [{ ...DOCS, state: { type: "delivered" } }], waits: ["failed"], received: [], waitingOn: [] }} />
            <PeerSentRow exchange={{ sends: [{ ...DOCS, state: { type: "delivered" } }, { ...NOTES, state: { type: "refused", reason: "Release notes 0.9 is archived." } }], waits: [], received: [], waitingOn: [] }} />
            <PeerRefusedRow to={NOTES} reason="Release notes 0.9 is archived." />
            <PeerRefusedRow to={null} reason="No session by that name." />
          </Column>
        </Row>
        <Row name="Its own brigadier wait">
          <Column>
            <SessionWaitRow keep="g-wait-1" to={[DOCS]} replies={[]} status="inProgress" />
            <SessionWaitRow keep="g-wait-2" to={[DOCS]} replies={[{ ...DOCS, text: REPLY }]} status="completed" />
            <SessionWaitRow keep="g-wait-3" to={[DOCS, NOTES]} replies={[{ ...DOCS, text: REPLY }, { ...NOTES, text: "No change needed in the notes." }]} status="completed" />
          </Column>
        </Row>
        <Row name="The 9th hop stops; only you send it on [D2034]">
          <State label="Stopped">
            <Column>
              <HopStopRow onSend={noop} />
            </Column>
          </State>
          <State label="Live: Send anyway">
            <Column>{sent ? <SessionSentRow to={DOCS} state="sent" text={MESSAGE} /> : <HopStopRow onSend={() => setSent(true)} />}</Column>
          </State>
        </Row>
      </Section>

      <Section title="Messages between sessions: the receiver">
        <Row name="Delivered: a bubble as yours, captioned (the time and Copy on hover)">
          <State label="From a session">
            <div className="flex w-140 flex-col">
              <PeerMessageBlock from={NOTES} text={MESSAGE} at={NOW - 3 * 60_000} />
            </div>
          </State>
          <State label="Hovered" frozen="hover">
            <div className="flex w-140 flex-col">
              <PeerMessageBlock from={NOTES} text="Can you double-check the retry numbers?" at={NOW - 3 * 60_000} />
            </div>
          </State>
          <State label="Its sender deleted">
            <div className="flex w-140 flex-col">
              <PeerMessageBlock from={GONE} text="Can you double-check the retry numbers?" at={NOW - 3 * 60_000} />
            </div>
          </State>
        </Row>
        <Row name="Queued during a turn: its row's label (joins the queue once wave 3's composer lands)">
          <State label="From a session">
            <FromPeer title={NOTES.title} />
          </State>
          <State label="Its sender deleted">
            <FromPeer title={null} />
          </State>
        </Row>
      </Section>

      <Section title="To ‹name›: the composer's chip (joins the composer once wave 3's lands)">
        <Row>
          <State label="Its tip">
            <HeldTo />
          </State>
          <State label="Sending">
            <ToWorkerChip worker={RETRY} sending onClear={noop} />
          </State>
          <State label="Live: a click takes it back">
            <div className="flex h-control-sm items-center">{to ? <ToWorkerChip worker={RETRY} onClear={() => setTo(false)} /> : <ComposerPill onClick={() => setTo(true)}>Pick Retry backoff again</ComposerPill>}</div>
          </State>
        </Row>
      </Section>
    </>
  );
}
