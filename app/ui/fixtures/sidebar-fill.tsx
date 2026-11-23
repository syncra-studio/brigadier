// Mockup only: the sidebar in the main area's fill. ?v=a is today's (its own fill, the 0.5px edge), ?v=b the page's fill
// with a 1px line at its edge, ?v=c the page's fill with no line, its rows' selection and hover the only structure.
// Each in the dark theme over a light one (the app has no light theme yet: fixtures.css's mockup-light stands in).
// The real sidebar on fake sessions; no daemon. Not the app.
import "../src/theme.css";
import "./fixtures.css";

import { useState } from "react";
import { createRoot } from "react-dom/client";

import { PlusButton, SharedComposer } from "../src/components/composer/composer";
import { SendButton } from "../src/components/composer/send-button";
import { cx } from "../src/components/cx";
import { SidebarProvider } from "../src/components/sidebar";
import { UserBubble } from "../src/components/thread/message";
import type { Project } from "../src/projects/projects";
import { AppSidebar } from "../src/sidebar/sidebar";
import type { SessionRow } from "../src/sidebar/words";
import { Markdown } from "../src/thread/markdown";

const NOW = Date.now();
const MIN = 60_000;
const PROJECTS: Project[] = [
  { id: "p1", name: "brigadier", folder: "/Users/me/code/brigadier" },
  { id: "p2", name: "website", folder: "/Users/me/code/website" },
  { id: "p3", name: "notes", folder: "/Users/me/notes" },
];
const row = (id: string, title: string, project: string | null, ago: number, extra: Partial<SessionRow> = {}): SessionRow => ({
  id, title, project, state: "idle", mark: null, resets: null, sent: NOW - ago * MIN, finished: NOW - ago * MIN, updated: NOW - ago * MIN, ...extra,
});
const ROWS: SessionRow[] = [
  row("s1", "Sidebar in the page's fill", "p1", 2),
  row("s2", "Fix the flaky tab test", "p1", 9, { state: "working", mark: "working" }),
  row("s3", "Rename the settings rows", "p1", 40, { mark: "unread" }),
  row("s4", "Why does CI fail on Windows?", "p1", 180),
  row("s5", "New pricing page", "p2", 25, { mark: "needs", state: "waiting_answer" }),
  row("s6", "Blog post: wave 4", "p2", 300),
  row("s7", "Weekly review", "p3", 900),
  row("s8", "Plan the trip", null, 60),
  row("s9", "Translate the README", null, 1400),
];

const ANSWER = `The sidebar now takes the main area's fill, so the window reads as one surface.

- **Rows** keep their hover and selected fills, which now carry the structure.
- The edge between the sidebar and the thread is ${"`main-surface`"}'s border.

Want me to try it with the right panel open too?`;

function Thread() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-reading flex-1 flex-col gap-6 overflow-y-auto px-6 pt-6">
        <UserBubble keep="mockup-ask" text="Put the sidebar in the same background as the thread." time={NOW - 3 * MIN} />
        <div className="text-chat-foreground">
          <Markdown keep="mockup-answer" text={ANSWER} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-reading px-4 pb-4">
        <SharedComposer plus={<PlusButton />} send={<SendButton empty running={false} canStop={false} onSend={() => {}} onStop={() => {}} />}>
          <div className="px-3 py-2 text-placeholder">Do anything</div>
        </SharedComposer>
      </div>
    </div>
  );
}

const VARIANT = { a: "", b: "mockup-flat-sidebar mockup-edge-1px", c: "mockup-flat-sidebar mockup-no-edge" } as const;
type V = keyof typeof VARIANT;

/** The window, its fixed parts held inside by `transform-gpu`, in one theme. */
function Window({ v, light }: { v: V; light?: boolean }) {
  const [open, setOpen] = useState(true);
  const [active, setActive] = useState("s1");
  return (
    <div className={cx("mockup-window relative transform-gpu overflow-hidden bg-background text-foreground", light && "mockup-light", VARIANT[v])}>
      <SidebarProvider open={open} onOpenChange={setOpen}>
        <AppSidebar storeKey={`mockup-sidebar-${light ? "light" : "dark"}`} rows={ROWS} projects={PROJECTS} active={active} offline={false} onOpen={setActive} onNewSession={() => {}} onNewChat={() => {}} />
        <div className="main-surface flex min-w-0 flex-1 flex-col overflow-clip pt-tab-bar">
          <Thread />
        </div>
      </SidebarProvider>
    </div>
  );
}

const v = (new URLSearchParams(location.search).get("v") ?? "a") as V;
createRoot(document.getElementById("root")!).render(
  <div className="flex h-full flex-col">
    <Window v={v in VARIANT ? v : "a"} />
    <Window v={v in VARIANT ? v : "a"} light />
  </div>,
);
