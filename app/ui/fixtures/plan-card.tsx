// Mockup only: the agent's plan as its own card under the summary card, shown and hidden with it. ?v=a progress bar,
// ?v=b checklist, ?v=c one line that opens. The summary card's real parts on fake data, one pane per state. Not the app.
import "../src/theme.css";
import "./fixtures.css";

import { Progress } from "@base-ui/react/progress";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { Button } from "../src/components/button";
import { CheckboxMark } from "../src/components/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../src/components/collapsible";
import { cx } from "../src/components/cx";
import { TooltipIconButton } from "../src/components/icon-button";
import { UserBubble } from "../src/components/thread/message";
import { TooltipProvider } from "../src/components/tooltip";
import { CheckCircle, ChevronDown, Dot, Globe, Minus, Spinner, Tasks, X } from "../src/icons";
import { WorkerGlyph } from "../src/icons/worker-glyphs";
import { CardSection, ChangesCard } from "../src/panel/card";
import type { SourceData } from "../src/panel/source/data";
import { Line, Rows } from "../src/panel/source/rows";
import { Markdown } from "../src/thread/markdown";

type Step = { text: string; status: string };
const ENDED = new Set(["completed", "cancelled"]);
/** A cancelled step counts in neither number. */
const progressOf = (plan: Step[]) => {
  const total = plan.filter((step) => step.status !== "cancelled").length;
  const done = plan.filter((step) => step.status === "completed").length;
  return { total, done, over: plan.every((step) => ENDED.has(step.status)) };
};
/** The step under way, else the next one. */
const currentOf = (plan: Step[]) => {
  const at = plan.findIndex((step) => step.status === "in_progress");
  return at >= 0 ? at : plan.findIndex((step) => !ENDED.has(step.status));
};
const hidden = (status: string) =>
  ({ completed: "Done: ", in_progress: "Under way: ", cancelled: "Cancelled: " })[status] ?? "To do: ";

/** A step whole, however long: its mark on the first line, its words wrapping under themselves. */
function StepRow({ step, mark, className, words }: { step: Step; mark: ReactNode; className?: string; words?: string }) {
  return (
    <li className={cx("relative flex min-w-0 items-start gap-2 rounded-sm px-2 py-1 text-label", className)}>
      <span aria-hidden className="flex h-4.5 min-w-5 shrink-0 items-center justify-center svg:size-4">{mark}</span>
      <span className={cx("min-w-0 flex-1 wrap-anywhere", words)}>
        <span className="sr-only">{hidden(step.status)}</span>
        {step.text}
      </span>
    </li>
  );
}
const SPIN = <Spinner className="animate-spin motion-reduce:animate-none" />;
const MARK: Record<string, ReactNode> = { completed: <CheckCircle />, in_progress: SPIN, cancelled: <X /> };

/** A: "3 of 5" and a thin bar always in view; the step under way on a fill; a long list scrolls under them, at that step. */
function PlanA({ plan }: { plan: Step[] }) {
  const { done, total, over } = progressOf(plan);
  const current = currentOf(plan);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const row = list.current?.children[current];
    if (list.current && row instanceof HTMLElement) list.current.scrollTop = row.offsetTop - list.current.offsetTop - list.current.clientHeight / 3;
  }, [current]);
  return (
    <>
      <div className="flex shrink-0 flex-col gap-2 px-2 pb-2">
        <div className="flex items-center gap-2 text-label text-muted-foreground">
          <h2 className="flex-1">Plan</h2>
          <span className="tabular-nums">{done} of {total}</span>
        </div>
        <Progress.Root value={total ? Math.round((done / total) * 100) : 100} aria-label="Plan progress">
          <Progress.Track className="block h-0.5 w-full overflow-hidden rounded-capsule bg-fill-hover">
            <Progress.Indicator className={cx("block h-full rounded-capsule motion-safe:transition-width", over ? "bg-success" : "bg-progress")} />
          </Progress.Track>
        </Progress.Root>
      </div>
      <ul ref={list} className="-me-2.5 flex max-h-75 min-h-0 flex-col gap-0.5 overflow-y-auto scroll-gutter">
        {plan.map((step, at) => (
          <StepRow
            key={at}
            step={step}
            mark={MARK[step.status] ?? <Dot />}
            className={step.status === "in_progress" ? "bg-fill font-medium" : ENDED.has(step.status) ? "text-faint-foreground" : "text-muted-foreground"}
          />
        ))}
      </ul>
    </>
  );
}

const BOX: Record<string, ReactNode> = {
  completed: <CheckboxMark checked />,
  in_progress: SPIN,
  cancelled: <Minus />,
};
const SHORT = 5;
/** B: a checklist: boxes, what's done struck through, "3/5"; past 5 it shows the five from just before the step under way. */
function PlanB({ plan }: { plan: Step[] }) {
  const { done, total } = progressOf(plan);
  const [all, setAll] = useState(false);
  const current = currentOf(plan);
  const start = Math.max(0, Math.min((current < 0 ? 0 : current) - 1, plan.length - SHORT));
  const shown = all ? plan : plan.slice(start, start + SHORT);
  return (
    <>
      <div className="flex items-center gap-2 px-2 pb-1 text-label text-muted-foreground">
        <h2 className="flex-1">Plan</h2>
        <span className="tabular-nums">{done}/{total}</span>
      </div>
      <ul className="flex flex-col">
        {shown.map((step, at) => (
          <StepRow
            key={all ? at : start + at}
            step={step}
            mark={BOX[step.status] ?? <CheckboxMark checked={false} />}
            className={cx(ENDED.has(step.status) && "text-muted-foreground", step.status === "in_progress" && "font-medium")}
            words={ENDED.has(step.status) ? "line-through" : undefined}
          />
        ))}
      </ul>
      {plan.length > SHORT && (
        <Line onClick={() => setAll(!all)} className="text-muted-foreground">
          {all ? "Show less" : `Show ${plan.length - shown.length} more`}
        </Line>
      )}
    </>
  );
}

/** C: one line, the step under way and the count; it opens to the list, what's done gathered in one row. */
function PlanC({ plan, startOpen = false }: { plan: Step[]; startOpen?: boolean }) {
  const { done, total, over } = progressOf(plan);
  const [open, setOpen] = useState(startOpen);
  const [earlier, setEarlier] = useState(false);
  const past = useId();
  const current = plan[currentOf(plan)];
  const ended = plan.filter((step) => ENDED.has(step.status));
  const left = plan.filter((step) => !ENDED.has(step.status));
  const row = (step: Step, at: number) => (
    <StepRow key={at} step={step} mark={MARK[step.status] ?? <Dot />} className={cx(ENDED.has(step.status) && "text-muted-foreground", step.status === "in_progress" && "font-medium")} />
  );
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col">
      <CollapsibleTrigger className="flex h-7 w-full min-w-0 shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-start text-label hover:bg-summary-row-hover focus-visible:focus-ring">
        <span aria-hidden className="flex min-w-5 shrink-0 items-center justify-center svg:size-4">{over ? <CheckCircle className="text-success" /> : open ? <Tasks /> : (MARK[current?.status ?? ""] ?? <Dot />)}</span>
        <span className="min-w-0 flex-1 truncate">{over ? "Plan done" : open ? "Plan" : current?.text}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{done}/{total}</span>
        <ChevronDown aria-hidden className={cx("size-icon-xs shrink-0 text-muted-foreground transition motion-reduce:transition-none", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="-me-2.5 flex max-h-60 flex-col overflow-y-auto pt-1 scroll-gutter">
          {ended.length > 0 && left.length > 0 && (
            <button type="button" aria-expanded={earlier} aria-controls={past} onClick={() => setEarlier(!earlier)} className="flex h-7 shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-label text-muted-foreground hover:bg-summary-row-hover focus-visible:focus-ring">
              <span aria-hidden className="flex min-w-5 justify-center svg:size-4"><CheckCircle /></span>
              {[done && `${done} done`, ended.length > done && `${ended.length - done} cancelled`].filter(Boolean).join(", ")}
              <ChevronDown aria-hidden className={cx("size-icon-xs transition motion-reduce:transition-none", !earlier && "-rotate-90")} />
            </button>
          )}
          <ul id={past} hidden={left.length > 0 && !earlier}>{ended.map(row)}</ul>
          <ul>{left.map(row)}</ul>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

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

// shell/summary-card.tsx's own surface, aside and motion.
const SURFACE = "pointer-events-auto flex w-75 max-w-full min-w-0 flex-col rounded-menu bg-popover p-3 shadow-summary";
type V = "a" | "b" | "c";
/**
 * Both cards, sliding in and out as one. In a short window: A, each card scrolls inside its share; B, the two scroll as
 * one column; C, the plan keeps its line and the summary card scrolls above it.
 */
function Cards({ v, shown, plan, tall, open }: { v: V; shown: boolean; plan: Step[]; tall: boolean; open?: boolean }) {
  return (
    <aside
      aria-label="Context"
      aria-hidden={!shown || undefined}
      className={cx(
        "pointer-events-none absolute inset-y-0 end-0 z-20 flex w-77 max-w-full flex-col gap-2 pe-2 pt-2 pb-2 summary-card-motion",
        v === "b" && "overflow-y-auto hide-scrollbar",
        !shown && "invisible translate-x-4 opacity-0",
      )}
    >
      <div className={cx(SURFACE, v === "b" ? "shrink-0" : "min-h-0 overflow-y-auto hide-scrollbar")}>
        <Summary tall={tall} />
      </div>
      {plan.length > 0 && (
        <section aria-label="Plan" className={cx(SURFACE, v === "a" ? "min-h-0" : "shrink-0")}>
          {v === "a" ? <PlanA plan={plan} /> : v === "b" ? <PlanB plan={plan} /> : <PlanC plan={plan} startOpen={open} />}
        </section>
      )}
    </aside>
  );
}

const steps = (texts: string[], at: number): Step[] => texts.map((text, i) => ({ text, status: i < at ? "completed" : i === at ? "in_progress" : "pending" }));
const FIVE = ["Read the summary card and its toggle", "User: check sidebar, Thinking line, Send button and the empty state", "Move the plan into its own card", "Keep both reachable in a short window", "Check it in the running app"];
const TWELVE = [
  "Read the plan from the session row", "List every place the card is drawn", "Take Plan out of the summary card", "Draw the new card's surface", "Share the summary card's toggle", "Follow the floating layout",
  "Count what's done and what's left", "Wrap long steps whole", "Keep both cards reachable in a short window", "Hide it where there is no plan", "Check every agent's statuses", "Show it running",
];
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
function Stage({ v, title, plan, tall = false, off = false, open, className = "h-160", step }: { v: V; title: string; plan: Step[]; tall?: boolean; off?: boolean; open?: boolean; className?: string; step?: boolean }) {
  const [shown, setShown] = useState(!off);
  const [at, setAt] = useState<number | null>(null);
  const now = at === null ? plan : steps(plan.map((each) => each.text), at);
  return (
    <section className="flex flex-col gap-2">
      <div className="flex h-7 items-center gap-2">
        <h2 className="flex-1 text-label text-muted-foreground">{title}</h2>
        {step && <Button size="sm" variant="secondary" onClick={() => setAt(((at ?? currentOf(plan)) + 1) % (plan.length + 1))}>Next step</Button>}
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
          <Cards v={v} shown={shown} plan={now} tall={tall} open={open} />
        </div>
      </div>
    </section>
  );
}

const v = (new URLSearchParams(location.search).get("v") ?? "a") as V;
const c = v === "c";
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <main className="mx-auto flex max-w-settings flex-col gap-8 p-6">
      <Stage v={v} title="One step running" plan={steps(FIVE, 2)} step />
      {c && <Stage v={v} title="One step running, opened" plan={steps(FIVE, 2)} open step />}
      <Stage v={v} title="All done" plan={steps(FIVE, 5)} />
      <Stage v={v} title="12 steps" plan={steps(TWELVE, 7)} open={c} className="h-180" step />
      <Stage v={v} title="A very long step" plan={LONG} open={c} className="h-165" />
      <Stage v={v} title="A step cancelled" plan={MIXED} open={c} />
      <Stage v={v} title="Tall summary card, short window" plan={steps(TWELVE, 7)} tall className="h-115" />
      <Stage v={v} title="Toggled off: both gone, the toolbar's button brings them back" plan={steps(FIVE, 2)} off className="h-160" />
      <Stage v={v} title="No plan: no card" plan={[]} className="h-90" />
    </main>
  </TooltipProvider>,
);
