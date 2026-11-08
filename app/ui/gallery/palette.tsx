// Step 1x's ⌘K palette on fake rows: each state frozen, plus a live copy [D196, D197].
import { useState } from "react";

import { Button } from "../src/components/button";
import { Dialog, DialogContent } from "../src/components/dialog";
import { type Hit, PALETTE_FRAME, PaletteBody, type PaletteProps, type PaletteRow, SearchPalette, type TextSearch, wordStarts } from "../src/palette/palette";
import { Held, Row, Section, State } from "./parts";
import { PROJECTS, ROWS } from "./sidebar";

// What some fake sessions said: Rust's message search stands in as a word-start match over one message [D72].
const SAID: Record<string, string> = {
  "4": "The login test fails on CI because the socket closes before the export finishes writing.",
  "6": "Most of the time goes into measuring rows, and the exports panel re-renders on every frame.",
  "8": "Make the hero say what the product does in one line, then export the copy for review.",
  "10": "Sockets stay open after the window closes; the daemon should own them instead.",
};
const said = (q: string): Hit[] =>
  Object.entries(SAID).flatMap(([id, text]) => {
    const at = wordStarts(text, q);
    return at ? [{ id, snippet: text, at }] : [];
  });
/** ⌘K's text search on fake data, answering after `ms`. */
const fakeSearch =
  (ms: number): TextSearch =>
  (q) =>
    new Promise((resolve) => setTimeout(() => resolve(said(q)), ms));
const AT_ONCE = fakeSearch(0);
const SLOW = fakeSearch(600);
const NEVER: TextSearch = () => new Promise(() => {});
const FAILS: TextSearch = async () => Promise.reject("index: database is locked");

const ARCHIVED: PaletteRow[] = [
  ...ROWS,
  { ...ROWS[7], id: "30", title: "Old export script", archived: true, sent: ROWS[0].sent + 1 },
  { ...ROWS[3], id: "31", title: "Retired dashboard", mark: null, archived: true, sent: ROWS[0].sent + 2 },
];

const nothing = () => {};

function Frozen({ label, ...props }: { label: string } & Partial<PaletteProps>) {
  return (
    <State label={label}>
      <Held className="h-136 w-168 overflow-hidden rounded-surface">
        {(box) => (
          <Dialog open modal={false}>
            <DialogContent container={box} initialFocus={false} showCloseButton={false} frame={PALETTE_FRAME} top="top-4">
              <PaletteBody rows={ROWS} projects={PROJECTS} offline={false} search={AT_ONCE} onOpenSession={nothing} onOpenProject={nothing} {...props} />
            </DialogContent>
          </Dialog>
        )}
      </Held>
    </State>
  );
}

function Live() {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState("nothing yet");
  return (
    <State label={`live (text answers after 600ms) · opened: ${opened}`}>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Search…
      </Button>
      <SearchPalette
        open={open}
        onOpenChange={setOpen}
        rows={ARCHIVED}
        projects={PROJECTS}
        offline={false}
        search={SLOW}
        onOpenSession={(id) => setOpened(`session ${id}`)}
        onOpenProject={(id) => setOpened(`project ${id}`)}
      />
    </State>
  );
}

export function PaletteGallery() {
  return (
    <Section title="Search palette (step 1x)">
      <Row name="live">
        <Live />
      </Row>
      <Row name="empty query: recent, needing you first · typed: titles at once, text after · project match">
        <Frozen label="empty query" />
        <Frozen label="“export”: titles, then message text with snippets" initialQuery="export" />
        <Frozen label="“brig”: a project" initialQuery="brig" />
      </Row>
      <Row name="searching · offline · nothing matches · error · archived last · loading · nothing yet">
        <Frozen label="searching (text still coming)" initialQuery="export" search={NEVER} />
        <Frozen label="offline: titles only" initialQuery="export" offline />
        <Frozen label="nothing matches" initialQuery="zebra" />
        <Frozen label="search failed" initialQuery="export" search={FAILS} />
        <Frozen label="archived last, tagged (rows get it with 1v)" rows={ARCHIVED} />
        <Frozen label="loading" rows={undefined} />
        <Frozen label="nothing yet" rows={[]} />
      </Row>
    </Section>
  );
}
