// A mockup tab, drawn on fake data [D2055, D2066]: the offer card, the chat rows, and every state of the tab. Frames
// show a fake app screen where the app shows the variant's live page.
import { useState } from "react";

import { RailItem } from "../src/components/composer/rail";
import { type PendingQuestion, QuestionCard } from "../src/components/composer/question";
import { cx } from "../src/components/cx";
import type { Hovered } from "../src/mockup/pins";
import { type MockupStart, MockupView } from "../src/mockup/mockup";
import type { Load, Mockup, Round, Variant } from "../src/mockup/model";
import { type MockupNote, NO_NOTES, type Notes } from "../src/mockup/notes";
import { busy, LETTERS } from "../src/mockup/model";
import { MockupRow, MockupTabIcon } from "../src/mockup/row";
import type { Send } from "../src/mockup/tray";
import { Row, Section, State } from "./parts";
import picture from "./sample.svg?no-inline";

const act = () => Promise.resolve();
const noop = () => {};
const run = async () => ({});

const offer = (reuse: boolean): PendingQuestion => ({
  id: reuse ? "offer-reuse" : "offer",
  title: "Want a mockup first?",
  held: true,
  items: [
    {
      text: "This changes how the whole sidebar looks. Drawn from your real components with fake data; you'll see them side by side.",
      options: [
        { label: "Yes, 3 variants", description: "Three takes, side by side" },
        { label: "Yes, just 1", description: "Cheaper: one take" },
        { label: "Skip, build it", description: "No mockup. The change goes straight in." },
        ...(reuse ? [{ label: "Reuse the other build", description: "Opens Sidebar density's mockup, from your other session" }] : []),
      ],
      recommended: 0,
      multiSelect: false,
    },
  ],
});

/** Each variant's look on the fake screen: its rows' height and count. */
const LOOK: Record<string, { row: string; rows: number }> = { A: { row: "h-4.5", rows: 6 }, B: { row: "h-2", rows: 10 }, C: { row: "h-5", rows: 5 }, Real: { row: "h-2", rows: 10 } };

/** A fake app screen: a sidebar of rows and a page, denser or roomier by variant. */
function FakeScreen({ variant }: { variant: string }) {
  const look = LOOK[variant] ?? LOOK.A!;
  return (
    <div className="flex size-full">
      <div className="flex w-1/3 flex-col gap-1 bg-card p-1.5">
        {Array.from({ length: look.rows }, (_, i) => (
          <div key={i} className={cx("rounded-xs", look.row, i === 0 ? "bg-fill-active" : "bg-fill")} />
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2">
        <div className="h-10 rounded-xs bg-fill" />
        <div className="h-3.5 w-4/5 rounded-xs bg-fill" />
        <div className="h-3.5 w-3/5 rounded-xs bg-fill" />
      </div>
    </div>
  );
}

const NAMES: Record<string, [string, string]> = { A: ["Roomy", "Same rows, smaller icons"], B: ["Compact", "28px rows, one line"], C: ["Two-line", "Title plus last message"] };
const variant = (letter: string, more: Partial<Variant> = {}): Variant => ({
  letter,
  name: NAMES[letter]![0],
  why: NAMES[letter]![1],
  url: `http://localhost:5173/__mockup/${letter.toLowerCase()}`,
  shot: null,
  ...more,
});
const ALL = LETTERS.map((l) => variant(l));
const note = (id: string, letter: string, x: number, y: number, text: string, name: string, file: string): MockupNote => ({ id, variant: letter, x, y, text, element: { name, file } });
const NOTES: MockupNote[] = [
  note("n1", "A", 0.12, 0.3, "Too small next to the text", "SidebarRow icon", "Sidebar.tsx:40"),
  note("n2", "B", 0.2, 0.09, "Keep this height, but more padding left", "SidebarRow", "Sidebar.tsx:42"),
  note("n3", "B", 0.6, 0.12, "Drop the search box", "SearchBox", "Search.tsx:12"),
];
const round = (variants: Variant[], drawing = false, sent: MockupNote[] = []): Round => ({ variants, drawing, sent });
const mockup = (rounds: Round[], more: Partial<Mockup> = {}): Mockup => ({ title: "Sidebar density", count: 3, rounds, picked: null, building: false, real: null, stopped: false, ...more });
const TWO = [round(ALL, false, NOTES), round([variant("A", { why: "Bigger icons (note 1)" }), variant("B", { why: "More left padding, no search (notes 2, 3)" }), variant("C", { why: "Unchanged" })])];
const HOVER: Record<string, Hovered> = { B: { x: 0.01, y: 0.06, width: 0.31, height: 0.04, element: { name: "SidebarRow", file: "Sidebar.tsx:42" } } };

/** One tab, as wide as the right pane shows it, with its own notes. */
function Tab({ of, notes: first = NO_NOTES, send = "idle", loads, hovers, start }: { of: Mockup | null; notes?: Notes; send?: Send; loads?: Record<string, Load>; hovers?: Record<string, Hovered>; start?: MockupStart }) {
  const [notes, setNotes] = useState(first);
  return (
    <div className="flex h-110 w-200 flex-col overflow-hidden rounded-surface border border-border">
      <MockupView
        mockup={of}
        notes={notes}
        onNotes={setNotes}
        send={send}
        active={false}
        page={(key) => <FakeScreen variant={key} />}
        actions={{ send: noop, use: noop, retry: noop, askAgain: noop, openReal: noop, openReview: noop }}
        loads={loads}
        hovers={hovers}
        start={start}
      />
    </div>
  );
}

export function MockupGallery() {
  return (
    <>
      <Section title="Mockup offer">
        <Row name="the card in the composer [D2058, D2067]">
          <State label="big UI change">
            <div className="w-140">
              <RailItem variant="decision" label="Waiting for you">
                <QuestionCard question={offer(false)} onAnswer={act} onDismiss={noop} session="" run={run} />
              </RailItem>
            </div>
          </State>
          <State label="another session built it">
            <div className="w-140">
              <RailItem variant="decision" label="Waiting for you">
                <QuestionCard question={offer(true)} onAnswer={act} onDismiss={noop} session="reuse" run={run} />
              </RailItem>
            </div>
          </State>
        </Row>
        <Row name="its rows in the chat">
          <div className="flex flex-col gap-2">
            <MockupRow moment={{ kind: "drawing", count: 3 }} live onOpen={noop} />
            <MockupRow moment={{ kind: "ready", round: 1, open: true }} live={false} onOpen={noop} />
            <MockupRow moment={{ kind: "notes", count: 3, on: ["A", "B"], round: 2 }} live onOpen={noop} />
            <MockupRow moment={{ kind: "picked", letter: "B" }} live onOpen={noop} />
            <MockupRow moment={{ kind: "built", letter: "B" }} live={false} onOpen={noop} />
            <MockupRow moment={{ kind: "stopped" }} live={false} onOpen={noop} />
          </div>
        </Row>
        <Row name="the tab's icon">
          <State label="drawing">
            <MockupTabIcon busy={busy(mockup([round([ALL[0]!], true)]))} />
            Mockup
          </State>
          <State label="waiting">
            <MockupTabIcon busy={false} />
            Mockup
          </State>
        </Row>
      </Section>
      <Section title="Mockup tab">
        <Row name="empty, and drawing variant by variant">
          <State label="no mockup">
            <Tab of={null} />
          </State>
          <State label="drawing 2 of 3">
            <Tab of={mockup([round([ALL[0]!], true)])} />
          </State>
        </Row>
        <Row name="side by side, point and comment">
          <State label="all drawn, pointing at B">
            <Tab of={mockup([round(ALL)])} hovers={HOVER} />
          </State>
          <State label="three notes and one for all">
            <Tab of={mockup([round(ALL)])} notes={{ pins: NOTES, all: "Try a 2px left accent on the open session" }} />
          </State>
        </Row>
        <Row name="sending and rounds">
          <State label="couldn't send">
            <Tab of={mockup([round(ALL)])} notes={{ pins: NOTES, all: "" }} send="failed" />
          </State>
          <State label="round 2 shows by itself">
            <Tab of={mockup(TWO)} />
          </State>
          <State label="round 2 ready · Show (a note unsent)">
            <Tab of={mockup(TWO)} notes={{ pins: [NOTES[0]!], all: "" }} start={{ round: 0, held: true }} />
          </State>
          <State label="round 1, read-only">
            <Tab of={mockup(TWO)} start={{ round: 0 }} />
          </State>
        </Row>
        <Row name="one variant, try, and a frame that won't load">
          <State label="B alone, Try">
            <Tab of={mockup([round(ALL)])} start={{ view: "B", mode: "try" }} />
          </State>
          <State label="C won't load">
            <Tab of={mockup([round(ALL.map((v) => (v.letter === "C" ? { ...v, shot: picture } : v)))])} loads={{ A: "loading", C: "failed" }} />
          </State>
        </Row>
        <Row name="Use, wire in and compare">
          <State label="Use B's confirm">
            <Tab of={mockup(TWO)} notes={{ pins: [note("n4", "B", 0.5, 0.3, "Open session gets the 2px accent", "SidebarRow", "Sidebar.tsx:42")], all: "" }} start={{ confirm: "B" }} />
          </State>
          <State label="building B into the app">
            <Tab of={mockup(TWO, { picked: "B", building: true })} />
          </State>
          <State label="B built, compared">
            <Tab of={mockup(TWO, { picked: "B", real: "http://localhost:5173/" })} />
          </State>
        </Row>
        <Row name="stopped">
          <State label="before drawing anything">
            <Tab of={mockup([round([], false)], { stopped: true })} />
          </State>
          <State label="the worker was stopped">
            <Tab of={mockup([round(ALL)], { stopped: true })} notes={{ pins: [NOTES[1]!], all: "" }} />
          </State>
        </Row>
      </Section>
    </>
  );
}
