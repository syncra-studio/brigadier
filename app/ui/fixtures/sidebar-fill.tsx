// Mockup only: the sidebar in the main area's fill with a 1px line at its edge (variant B, ?v=b), now the app's own: the
// real sidebar and main area on fake sessions. ?v=real is the whole app itself, on a stub daemon that hands it the same
// sessions and answers nothing else. Both keep the sidebar open in a pane narrower than the app's 960px fold. Not the app.
import "../src/theme.css";
import "./sidebar-fill.css";

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
].map((project, at) => ({ ...project, trusted: true, setup: "", include: [], added: NOW - (3 - at) * 86_400_000 }));
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

/** The window: the real sidebar and main area. */
function Window() {
  const [open, setOpen] = useState(true);
  const [active, setActive] = useState("s1");
  return (
    <SidebarProvider open={open} onOpenChange={setOpen}>
      <AppSidebar storeKey="mockup-sidebar" rows={ROWS} projects={PROJECTS} active={active} offline={false} onOpen={setActive} onNewSession={() => {}} onNewChat={() => {}} />
      <div className="main-surface flex min-w-0 flex-1 flex-col overflow-clip pt-tab-bar">
        <Thread />
      </div>
    </SidebarProvider>
  );
}

/** What main hands the page in the app: a port to the daemon, here one that lists the fake sessions, says onboarding is done, and refuses the rest. */
function fakeDaemon() {
  const { port1, port2 } = new MessageChannel();
  const say = (frame: object) => {
    const json = new TextEncoder().encode(JSON.stringify(frame));
    const out = new Uint8Array(4 + json.length);
    new DataView(out.buffer).setUint32(0, json.length);
    out.set(json, 4);
    port2.postMessage(out);
  };
  port2.onmessage = ({ data }: MessageEvent<Uint8Array>) => {
    const { id, op, args = [] } = JSON.parse(new TextDecoder().decode(data.subarray(4)));
    if (op === "subscribe") say({ re: id, n: 1, projects: PROJECTS, rows: ROWS.map((each) => ({ backend: "claude", items: 0, error: null, ...each })) });
    else if (op === "run" && args[0] === "profile") say({ re: id, ok: true, onboarded: true, intro_seen: true, agents: [] });
    else say({ re: id, ok: false, error: "not in this mockup", message: "Not in this mockup" });
  };
  window.postMessage("daemon-port", "*", [port1]);
  say({ status: "running", pid: 1, version: "mockup", build: 0 });
}

if (new URLSearchParams(location.search).get("v") === "real") {
  location.hash = "#thread/s1";
  fakeDaemon();
  void import("../src/main");
} else createRoot(document.getElementById("root")!).render(<Window />);
