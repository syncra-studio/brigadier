// Mockup only: the agent's plan as its own card under the summary card, shown and hidden with it. ?v=c is variant C, one
// pane per state on fake data; ?v=real is the real chat pane and its toggle, on a fake daemon. Not the app.
import "../src/theme.css";
import "./fixtures.css";

import { useState } from "react";
import { createRoot } from "react-dom/client";

import { Button } from "../src/components/button";
import { cx } from "../src/components/cx";
import { TooltipIconButton } from "../src/components/icon-button";
import { UserBubble } from "../src/components/thread/message";
import { TooltipProvider } from "../src/components/tooltip";
import { useDaemon } from "../src/daemon";
import { Globe, Tasks } from "../src/icons";
import { WorkerGlyph } from "../src/icons/worker-glyphs";
import { CardSection, ChangesCard } from "../src/panel/card";
import { planFolds, type Step } from "../src/panel/plan";
import type { SourceData } from "../src/panel/source/data";
import { Line, Rows } from "../src/panel/source/rows";
import { Cards, SummaryCard } from "../src/shell/summary-card";
import { TabbedMain } from "../src/shell/tab-views";
import { Toolbar } from "../src/shell/toolbar";
import { Markdown } from "../src/thread/markdown";

const FILE = (path: string, added: number, removed: number) => ({ path, status: "modified" as const, oldPath: null, added, removed });
const DATA: SourceData = {
  source: {
    checkout: "worktree", branch: "brigadier/plan-card", remote: "origin", upstream: null, ahead: 2, behind: 0, staged: [],
    changes: [FILE("app/ui/src/panel/card.tsx", 48, 21), FILE("app/ui/src/shell/summary-card.tsx", 14, 8)],
    merging: null, rebasing: null, sinceBase: [],
  },
};
const WORKERS = ["Plan card mockup", "Message line and draft", "Pills in the composer", "Peer session shows messages", "Wire the toggle", "Check narrow panes"];
const SOURCES = ["assistant-ui.com", "react.dev", "base-ui.com", "tailwindcss.com"];

/** What the summary card keeps once the plan has left it. */
function Summary({ tall }: { tall: boolean }) {
  return (
    <>
      <ChangesCard data={DATA} project="brigadier" nowMs={Date.now()} />
      <CardSection title="Workers" fold="mockup-workers" count={tall ? 6 : 2}>
        <Rows items={WORKERS.slice(0, tall ? 6 : 2)}>
          {(name, at) => <Line key={name} icon={<WorkerGlyph id={`w${at}`} />} end={at ? "Done" : "Working"}>{name}</Line>}
        </Rows>
      </CardSection>
      <CardSection title="Sources" fold="mockup-sources" count={tall ? 4 : 1}>
        <Rows items={SOURCES.slice(0, tall ? 4 : 1)}>{(name) => <Line key={name} icon={<Globe />}>{name}</Line>}</Rows>
      </CardSection>
    </>
  );
}

const steps = (texts: string[], at: number): Step[] => texts.map((text, i) => ({ text, status: i < at ? "completed" : i === at ? "in_progress" : "pending" }));
const FIVE = ["Read the summary card and its toggle", "User: check sidebar, Thinking line, Send button and the empty state", "Move the plan into its own card", "Keep both reachable in a short window", "Check it in the running app"];
const TWELVE = [
  "Read the plan from the session row", "List every place the card is drawn", "Take Plan out of the summary card", "Draw the new card's surface", "Share the summary card's toggle", "Follow the floating layout",
  "Count what's done and what's left", "Wrap long steps whole", "Keep both cards reachable in a short window", "Hide it where there is no plan", "Check every agent's statuses", "Show it running",
];
/** Where the plan is after one more step. */
const after = (plan: Step[]) => (plan.filter((step) => step.status === "completed").length + 1) % (plan.length + 1);
const LONG = steps([
  FIVE[0]!,
  "Work through each of the user's notes in order: check the sidebar, the Thinking line, the Send button and the empty state, then compare app/ui/src/shell/summary-card.tsx with the old app and fix what differs",
  FIVE[3]!,
], 1);
const MIXED: Step[] = steps(FIVE, 2).map((step, at) => (at === 3 ? { ...step, status: "cancelled" } : step));

const THREAD = `The plan is its own card now, under the summary card.

- Both follow the one toggle in the toolbar.
- With no plan there is no second card.`;

/** One state, in a pane of its own: the toolbar's real toggle over a thread. */
function Stage({ title, plan, tall = false, off = false, open, className = "h-160", step }: { title: string; plan: Step[]; tall?: boolean; off?: boolean; open?: boolean; className?: string; step?: boolean }) {
  if (open && !planFolds.has(title)) planFolds.set(title, { open, earlier: false });
  const [shown, setShown] = useState(!off);
  const [at, setAt] = useState<number | null>(null);
  const now = at === null ? plan : steps(plan.map((each) => each.text), at);
  return (
    <section className="flex flex-col gap-2">
      <div className="flex h-7 items-center gap-2">
        <h2 className="flex-1 text-label text-muted-foreground">{title}</h2>
        {step && <Button size="sm" variant="secondary" onClick={() => setAt(after(now))}>Next step</Button>}
      </div>
      <div className={cx("flex flex-col overflow-clip rounded-menu border border-border bg-background", className)}>
        <div className="flex h-tab-bar shrink-0 items-center border-b border-border px-3">
          <span className="min-w-0 flex-1 truncate text-sm">Plan in its own card</span>
          <TooltipIconButton look="bar" tooltip="Toggle pinned summary" pressed={shown} onClick={() => setShown(!shown)}>
            <Tasks />
          </TooltipIconButton>
        </div>
        <div className="relative min-h-0 flex-1 overflow-clip">
          <div className={cx("flex flex-col gap-6 py-6 ps-6 text-chat-foreground", shown ? "pe-82" : "pe-6")}>
            <UserBubble keep={`ask-${title}`} text="Move the plan out of the summary card." time={Date.now()} />
            <Markdown keep={`answer-${title}`} text={THREAD} />
          </div>
          <SummaryCard shown={shown}>
            <Cards owner={title} plan={now}>
              <Summary tall={tall} />
            </Cards>
          </SummaryCard>
        </div>
      </div>
    </section>
  );
}

const REAL = "real";
let plan = steps(FIVE, 2);
let moveOn = () => {};
/** What main hands the page in the app: a port to the daemon, here one with one session, its checkout and its plan. */
function fakeDaemon() {
  const { port1, port2 } = new MessageChannel();
  const row = () => ({ id: REAL, title: "Plan in its own card", state: "idle", reason: null, mark: null, resets: null, sent: 0, finished: 0, project: "p", backend: "claude", updated: 1, items: 0, error: null, plan });
  const say = (frame: object) => {
    const json = new TextEncoder().encode(JSON.stringify(frame));
    const out = new Uint8Array(4 + json.length);
    new DataView(out.buffer).setUint32(0, json.length);
    out.set(json, 4);
    port2.postMessage(out);
  };
  const files = DATA.source!.changes;
  port2.onmessage = ({ data }: MessageEvent<Uint8Array>) => {
    const { id, op, args = [] } = JSON.parse(new TextDecoder().decode(data.subarray(4)));
    const asked = (args as string[]).join(" ");
    if (op === "subscribe") say({ re: id, ok: true, n: 1, rows: [row()], projects: [{ id: "p", name: "brigadier", folder: "/brigadier", trusted: true, setup: "", include: [], added: 0 }] });
    else if (op === "git") say({ re: id, ok: true, n: 1, git: { head: { ...DATA.source, head: null }, files: files.map(({ path }) => ({ path, old: null, staged: null, changes: "modified" })) } });
    else if (asked.endsWith("review uncommitted")) say({ re: id, ok: true, review: { files: files.map(({ path, added, removed }) => ({ path, insertions: added, deletions: removed })) } });
    else if (asked.startsWith("attach")) say({ re: id, ok: true, files: [] });
    else say({ re: id, ok: false, error: "Not in this mockup", message: "Not in this mockup" });
  };
  window.postMessage("daemon-port", "*", [port1]);
  say({ status: "running", pid: 1, version: "mockup", build: 0 });
  let n = 1;
  moveOn = () => {
    plan = steps(FIVE, after(plan));
    say({ n: ++n, rows: [row()], gone: [] });
  };
}

/** The real chat pane over a thread, and the toolbar's real toggle. */
function Real() {
  if (!useDaemon().rows) return null;
  return (
    <div className="flex h-dvh flex-col">
      <div className="flex h-tab-bar shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-sm">Plan in its own card</span>
        <Button size="sm" variant="secondary" onClick={() => moveOn()}>Next step</Button>
        <Toolbar owner={REAL} />
      </div>
      <TabbedMain owner={REAL} archived={false}>
        <div className="mx-auto flex w-full max-w-reading flex-col gap-6 p-6 text-chat-foreground">
          <UserBubble keep="ask" text="Move the plan out of the summary card." time={Date.now()} />
          <Markdown keep="answer" text={THREAD} />
        </div>
      </TabbedMain>
    </div>
  );
}

const real = new URLSearchParams(location.search).get("v") === "real";
if (real) fakeDaemon();
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    {real ? (
      <Real />
    ) : (
      <main className="mx-auto flex max-w-settings flex-col gap-8 p-6">
        <Stage title="One step running" plan={steps(FIVE, 2)} step />
        <Stage title="One step running, opened" plan={steps(FIVE, 2)} open step />
        <Stage title="All done" plan={steps(FIVE, 5)} />
        <Stage title="12 steps" plan={steps(TWELVE, 7)} open className="h-180" step />
        <Stage title="A very long step" plan={LONG} open className="h-165" />
        <Stage title="A step cancelled" plan={MIXED} open />
        <Stage title="Tall summary card, short window" plan={steps(TWELVE, 7)} tall className="h-115" />
        <Stage title="Toggled off: both gone, the toolbar's button brings them back" plan={steps(FIVE, 2)} off className="h-160" />
        <Stage title="No plan: no card" plan={[]} className="h-90" />
      </main>
    )}
  </TooltipProvider>,
);
