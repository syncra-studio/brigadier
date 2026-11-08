// Step 1c's sidebar on fake rows: every mark, its hover card, and both layouts [D173, D174].
import { useState } from "react";

import { NavList } from "../src/components/nav";
import { type Hit, type TextSearch, wordStarts } from "../src/palette/palette";
import { SidebarProvider } from "../src/components/sidebar";
import { RowMark, SessionRowItem } from "../src/sidebar/row";
import { AppSidebar } from "../src/sidebar/sidebar";
import { type Project, type SessionRow, statusWords } from "../src/sidebar/words";
import { Held, Row, Section, State } from "./parts";

export const PROJECTS: Project[] = [
  { id: "p1", name: "brigadier" },
  { id: "p2", name: "landing-site" },
  { id: "p3", name: "Old prototypes" },
];

const at = (h: number, m: number) => new Date(2026, 10, 8, h, m).getTime();
const row = (id: string, title: string, state: string, mark: SessionRow["mark"], project: string | null, extra: Partial<SessionRow> = {}): SessionRow => ({
  id,
  title,
  state,
  mark,
  resets: null,
  sent: at(12, 60 - Number(id)),
  finished: 0,
  project,
  ...extra,
});

export const ROWS: SessionRow[] = [
  row("1", "Fix brigadier-core tests", "working", "working", "p1"),
  row("2", "Rate limit the exports", "waiting_answer", "needs", "p1"),
  row("3", "Deploy the preview", "sign_in", "needs", "p2"),
  row("4", "Flaky login test on CI", "failed", "amber", "p1"),
  row("5", "Translate the pricing page", "limited", "amber", "p2", { resets: at(14, 10) }),
  row("6", "Profile the thread view", "stalled", "amber", "p1"),
  row("7", "Greeting", "idle", "unread", "p2"),
  row("8", "Landing page hero copy", "idle", null, "p2"),
  row("9", "Run the nightly build", "idle_jobs", "working", "p1"),
  row("10", "A session from before projects", "stopped", null, null),
  row("11", "Clean up the old exports", "waiting_answer", "needs", "p1", { reason: { approval: "r1" } }),
];

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
export const fakeSearch =
  (ms: number): TextSearch =>
  (q) =>
    new Promise((resolve) => setTimeout(() => resolve(said(q)), ms));
const SEARCH = fakeSearch(400);

// Two pinned, and a long tail of quiet ones that pushes the rows needing you out of view, so the pill shows [D185, D200].
const LONG: SessionRow[] = [
  ...ROWS.map((each) => (each.id === "4" || each.id === "8" ? { ...each, pinned: at(9, Number(each.id)) } : each)),
  ...Array.from({ length: 14 }, (_, n) => row(String(20 + n), `Earlier session ${n + 1}`, "idle", null, n % 2 ? "p1" : "p2", { sent: at(8, n) })),
];

// The second demo opens on Group by project; after that it keeps what you pick.
if (localStorage.getItem("gallery-sidebar-b.grouping") === null) localStorage.setItem("gallery-sidebar-b.grouping", JSON.stringify("project"));

function Demo({ storeKey, rows, offline = false }: { storeKey: string; rows: SessionRow[] | undefined; offline?: boolean }) {
  const [open, setOpen] = useState(true);
  const [width, setWidth] = useState<number | null>(null);
  const [active, setActive] = useState<string | null>("4");
  return (
    <div className="relative h-120 w-160 transform-gpu overflow-hidden rounded-surface border border-divider bg-chrome">
      <SidebarProvider open={open} onOpenChange={setOpen} width={width} onWidthChange={setWidth}>
        <AppSidebar
          rows={rows}
          projects={PROJECTS}
          active={active}
          home={active === null}
          offline={offline}
          onOpen={setActive}
          onNewSession={() => setActive(null)}
          storeKey={storeKey}
          search={SEARCH}
        />
        <div className="flex flex-1 p-4 pt-titlebar text-sm text-muted-foreground">{active === null ? "Home" : `Session ${active}`}</div>
      </SidebarProvider>
    </div>
  );
}

export function SidebarGallery() {
  return (
    <Section title="Sidebar (step 1c)">
      <Row name="marks: working · needs you · failed or stuck · new reply · none">
        {ROWS.slice(0, 9).map((each) => (
          <State key={each.id} label={statusWords(each) ?? "none"}>
            <RowMark mark={each.mark} label={statusWords(each) ?? ""} />
          </State>
        ))}
      </Row>
      <Row name="hover card · each state in words">
        {[ROWS[1], ROWS[10], ROWS[4], ROWS[5], ROWS[6], ROWS[9]].map((each) => (
          <State key={each.id} label={statusWords(each) ?? "says nothing"}>
            <Held className="h-40 w-140">
              {(box) => (
                <NavList className="w-60">
                  <SessionRowItem row={each} project={PROJECTS.find((p) => p.id === each.project)} active={false} badged held={box} onOpen={() => {}} onRename={() => {}} />
                </NavList>
              )}
            </Held>
          </State>
        ))}
      </Row>
      <Row name="live: one list (View › Group by switches it) · Group by project · loading · empty · offline">
        <State label="one list">
          <Demo storeKey="gallery-sidebar-a" rows={ROWS} />
        </State>
        <State label="group by project">
          <Demo storeKey="gallery-sidebar-b" rows={ROWS} />
        </State>
        <State label="loading">
          <Demo storeKey="gallery-sidebar-c" rows={undefined} />
        </State>
        <State label="empty">
          <Demo storeKey="gallery-sidebar-d" rows={[]} />
        </State>
        <State label="pinned · need-you pill (scroll the list)">
          <Demo storeKey="gallery-sidebar-f" rows={LONG} />
        </State>
        <State label="offline">
          <Demo storeKey="gallery-sidebar-e" rows={ROWS} offline />
        </State>
      </Row>
    </Section>
  );
}
