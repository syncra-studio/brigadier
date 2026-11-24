// Mockup only: the summary card's Background processes with its workers' processes too, each with its owner and Stop,
// those that outlived a finished worker among them. ?v=a, b or c; fake processes kept in memory. Not the app.
import "../src/theme.css";
import "./fixtures.css";

import { type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { cx } from "../src/components/cx";
import { TooltipIconButton } from "../src/components/icon-button";
import { UserBubble } from "../src/components/thread/message";
import { TooltipProvider } from "../src/components/tooltip";
import { StopCircle, Terminal, Warning } from "../src/icons";
import { WorkerGlyph } from "../src/icons/worker-glyphs";
import { Clock } from "../src/landing/icons";
import { CardSection, ChangesCard } from "../src/panel/card";
import { Line, Rows } from "../src/panel/source/rows";
import { SummaryPane, useCardToggle } from "../src/shell/summary-card";
import { Markdown } from "../src/thread/markdown";
import { duration, useSecond } from "../src/thread/words";
import { finished, lowerFirst, type Worker, WorkerName } from "../src/workers/chip";
import { TeamCard } from "../src/workers/live";
import { RowTime } from "../src/workers/strip";

const NOW = Date.now();
const MIN = 60_000;
const worker = (id: string, name: string, kind: Worker["kind"], word: string, started: number, last?: number): Worker => ({
  id, name, kind, word, startedAt: NOW - started * MIN, lastAt: last === undefined ? undefined : NOW - last * MIN,
});
const WORKERS: Worker[] = [
  worker("w1", "Fix the flaky tab test", "working", "Working", 6),
  worker("w2", "Mockup: sidebar fill", "needsYou", "Ready · pick one", 58),
  worker("w3", "Redraw the settings rows", "done", "Done", 700, 640),
  worker("w4", "Review the merge", "done", "Done", 190, 125),
];

/** One process; `owner` null is this session's own. */
type Job = { pid: number; label: string; owner: Worker | null; startedAt: number };
const job = (pid: number, owner: Worker | null, label: string, ago: number): Job => ({ pid, owner, label, startedAt: NOW - ago * MIN });
const JOBS: Job[] = [
  job(4101, null, "cargo watch -x check", 26),
  job(4102, WORKERS[0]!, "pnpm vite app/ui --port 5188", 4),
  job(4103, WORKERS[1]!, "pnpm vite app/ui --port 5201", 52),
  job(4104, WORKERS[2]!, "node_modules/.bin/vite app/ui --port 5174", 671),
  job(4105, WORKERS[3]!, "target/debug/brigadier-host --test", 166),
  job(4106, WORKERS[3]!, "target/debug/brigadierd", 165),
];

/** Outlived the worker that started it. */
const left = (each: Job) => each.owner !== null && finished(each.owner);

type Stop = (jobs: readonly Job[]) => void;

function Section({ fold, count, children }: { fold: string; count: number; children: ReactNode }) {
  return (
    <CardSection
      title="Background processes"
      fold={`mockup-${fold}`}
      count={count}
      end={
        <TooltipIconButton tooltip="Background history" size="icon-xs">
          <Clock />
        </TooltipIconButton>
      }
    >
      {children}
    </CardSection>
  );
}

const StopButton = ({ job: each, stop }: { job: Job; stop: Stop }) => (
  <TooltipIconButton tooltip="Stop" aria-label={`Stop ${each.label}`} size="icon-xs" className="text-muted-foreground hover:text-foreground" onClick={() => stop([each])}>
    <StopCircle />
  </TooltipIconButton>
);

/** A worker as an owner: its name, which opens it, and its state word once it's finished. */
function Owner({ owner, glyph = true }: { owner: Worker; glyph?: boolean }) {
  const done = finished(owner);
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <WorkerName worker={owner} glyph={glyph} />
      <span className={cx("flex shrink-0 items-center gap-1", done && "text-warning")}>
        {lowerFirst(owner.word.split(" · ")[0]!)}
        {done && <RowTime worker={owner} ago />}
      </span>
    </span>
  );
}

/** A: one list, longest running first, the owner on a line of its own under each command. */
function VariantA({ jobs, stop }: { jobs: readonly Job[]; stop: Stop }) {
  const now = useSecond(jobs.length > 0);
  return (
    <Section fold="a" count={jobs.length}>
      <Rows items={jobs.toSorted((a, b) => a.startedAt - b.startedAt)}>
        {(each) => (
          <div key={each.pid} className="group/row relative flex min-w-0 items-start gap-2 rounded-sm px-2 py-1 text-label hover:bg-summary-row-hover" title={each.label}>
            <span aria-hidden className="flex h-4.5 min-w-5 shrink-0 items-center justify-center">
              {each.owner ? <WorkerGlyph id={each.owner.id} className="size-4" /> : <Terminal className="size-4" />}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 gap-2">
                <span className="min-w-0 flex-1 truncate">{each.label}</span>
                <span className="shrink-0 text-muted-foreground tabular-nums">{duration(now - each.startedAt)}</span>
              </span>
              {each.owner ? <Owner owner={each.owner} glyph={false} /> : <span className="text-xs text-muted-foreground">This session</span>}
            </span>
            <span className="row-backing row-backing-hover absolute inset-y-0 end-0 flex items-center rounded-e-sm ps-4 pe-1 opacity-0 transition-opacity group-hover/row:opacity-100 group-has-focus-visible/row:opacity-100">
              <StopButton job={each} stop={stop} />
            </span>
          </div>
        )}
      </Rows>
    </Section>
  );
}

/** B: a group per owner, its rows as today's under it. */
function VariantB({ jobs, stop }: { jobs: readonly Job[]; stop: Stop }) {
  const now = useSecond(jobs.length > 0);
  const owners = [...new Set(jobs.map((each) => each.owner))];
  return (
    <Section fold="b" count={jobs.length}>
      {owners.map((owner) => (
        <div key={owner?.id ?? "own"} role="group" aria-label={owner?.name ?? "This session"} className="flex min-w-0 flex-col pb-1 last:pb-0">
          <div className="flex h-6 min-w-0 items-center px-2">{owner ? <Owner owner={owner} /> : <span className="text-xs text-muted-foreground">This session</span>}</div>
          <Rows items={jobs.filter((each) => each.owner === owner)}>
            {(each) => (
              <Line key={each.pid} icon={<Terminal />} title={each.label} end={duration(now - each.startedAt)} action={<StopButton job={each} stop={stop} />}>
                {each.label}
              </Line>
            )}
          </Rows>
        </div>
      ))}
    </Section>
  );
}

/** C: one line each with its owner at the end; those left by finished workers apart, with Stop always there. */
function VariantC({ jobs, stop }: { jobs: readonly Job[]; stop: Stop }) {
  const now = useSecond(jobs.length > 0);
  const leftover = jobs.filter(left);
  return (
    <Section fold="c" count={jobs.length}>
      <Rows items={jobs.filter((each) => !left(each))}>
        {(each) => (
          <Line
            key={each.pid}
            icon={each.owner ? <WorkerGlyph id={each.owner.id} /> : <Terminal />}
            title={`${each.label}\n${each.owner?.name ?? "This session"}`}
            end={<span className="max-w-20 truncate">{each.owner?.name ?? "This session"}</span>}
            action={
              <span className="flex items-center gap-1.5 text-label text-muted-foreground tabular-nums">
                {duration(now - each.startedAt)}
                <StopButton job={each} stop={stop} />
              </span>
            }
          >
            {each.label}
          </Line>
        )}
      </Rows>
      {leftover.length > 0 && (
        <div role="group" aria-label="Left by finished workers" className="mt-1 flex min-w-0 flex-col">
          <Line
            icon={<Warning />}
            className="text-warning"
            end={
              <button type="button" className="shrink-0 cursor-pointer rounded-sm text-link hover:underline focus-visible:focus-ring" onClick={() => stop(leftover)}>
                Stop all
              </button>
            }
          >
            {leftover.length} left by finished workers
          </Line>
          <Rows items={leftover}>
            {(each) => (
              <Line
                key={each.pid}
                icon={<WorkerGlyph id={each.owner!.id} />}
                title={`${each.label}\n${each.owner!.name}, ${duration(now - each.startedAt)}`}
                end={
                  <>
                    <span className="max-w-20 truncate">{each.owner!.name}</span>
                    <StopButton job={each} stop={stop} />
                  </>
                }
              >
                {each.label}
              </Line>
            )}
          </Rows>
        </div>
      )}
    </Section>
  );
}

const ANSWER = `The tab test waits for the panel's own transition now, and two workers are still at it.

- **Fix the flaky tab test** runs the app on port 5188 to check it.
- **Mockup: sidebar fill** keeps its page up until you pick one.`;

const VARIANTS = { a: VariantA, b: VariantB, c: VariantC };
const v = new URLSearchParams(location.search).get("v") as keyof typeof VARIANTS | null;
const Variant = VARIANTS[v ?? "a"] ?? VariantA;
const OWNER = "mockup";

function Page() {
  const [jobs, setJobs] = useState(JOBS);
  // In a pane too narrow to pin it, the card stays open, as if its toggle had just been clicked.
  const { shown, toggle } = useCardToggle(OWNER);
  useEffect(() => {
    if (!shown) toggle();
  }, [shown, toggle]);
  const card = (
    <>
      <ChangesCard
        data={{ source: { checkout: "worktree", branch: "fix-the-tab-test", remote: null, upstream: null, ahead: 0, behind: 0, staged: [], changes: [{ path: "app/ui/src/shell/tab-views.tsx", status: "M", added: 41, removed: 12 }], merging: null, rebasing: null, sinceBase: [] } as never }}
        nowMs={NOW}
        project="brigadier"
      />
      <TeamCard owner={OWNER} title="Workers" workers={WORKERS} />
      <Variant jobs={jobs} stop={(gone) => setJobs((was) => was.filter((each) => !gone.includes(each)))} />
    </>
  );
  return (
    <SummaryPane owner={OWNER} card={card}>
      <div className="mx-auto flex w-full max-w-reading flex-1 flex-col gap-6 px-6 pt-6">
        <UserBubble keep="mockup-ask" text="Why does the tab test fail one run in five?" time={NOW - 8 * MIN} />
        <div className="text-chat-foreground">
          <Markdown keep="mockup-answer" text={ANSWER} />
        </div>
      </div>
    </SummaryPane>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <Page />
  </TooltipProvider>,
);
