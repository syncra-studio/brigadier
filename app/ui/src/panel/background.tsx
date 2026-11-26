import { useState } from "react";

import { TooltipIconButton } from "../components/icon-button";
import { showToast } from "../components/toast";
import { useDaemon } from "../daemon";
import { StopCircle, Terminal, Warning } from "../icons";
import { WorkerGlyph } from "../icons/worker-glyphs";
import { Clock } from "../landing/icons";
import { errorText, run } from "../onboarding/api";
import { duration, useSecond } from "../thread/words";
import { onHand, type Worker } from "../workers/chip";
import { useFamily } from "../workers/live";
import { CardSection } from "./card";
import { openBackgroundHistory } from "./open";
import { Line, Rows } from "./source/rows";
import type { Job } from "./types";

/** A process on the card: the session it's left by, and its worker, null for the card's own session. */
type Process = Job & { session: string; owner: Worker | null };

const keyOf = (job: Job) => `${job.pid}.${job.start_us}`;
/** Outlived the worker that started it. */
const left = (job: Process) => job.owner !== null && !onHand(job.owner);
const nameOf = (job: Job) => (job.apps.length === 1 ? job.apps[0]!.label : job.label);
const portsOf = (job: Job) => job.ports.map((port) => `:${port}`);
/**
 * A job that opened several apps is a row each, and one for the ports none of them listens on.
 * shortcut: that one's Stop ends the job, its apps too; upgrade if a job with both shows.
 */
const rowsOf = (job: Process): Process[] =>
  left(job) || job.apps.length < 2
    ? [job]
    : [...job.apps.map((app) => ({ ...job, ...app, apps: [app] })), { ...job, apps: [], ports: job.ports.filter((port) => !job.apps.some((app) => app.ports.includes(port))) }];
const ranFor = (job: Job, now: number) => duration(now - job.start_us / 1000);

/**
 * The card's Background processes [D145, D73, D105]: the servers, each with the ports
 * it listens on, and the open apps that the ended turns of the session and its workers left running, with their owner,
 * and on hover how long each has run and Stop; all that outlived its worker comes apart, with Stop always there and Stop
 * all. Stopped, a row goes at once; Rust's row confirms it, and a failed stop brings it back with a toast. No section
 * until something has run; once one has, the session's or a worker's, its title keeps the clock that opens their
 * Background history [D200].
 */
export function BackgroundCard({ owner }: { owner: string }) {
  const row = useDaemon().rows?.find((each) => each.id === owner);
  const family = useFamily(owner);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const jobs: Process[] = [
    ...(row?.background ?? []).map((job) => ({ ...job, session: owner, owner: null })),
    ...family.flatMap(({ worker, row }) => (row.background ?? []).map((job) => ({ ...job, session: row.id, owner: worker }))),
  ]
    .flatMap(rowsOf)
    .filter((job) => !stopping.has(keyOf(job)) && (left(job) || job.apps.length || job.ports.length));
  const now = useSecond(jobs.length > 0);
  const ran = row?.background_ran || family.some((each) => each.row.background_ran);
  if (jobs.length === 0 && !ran) return null;
  const leftover = jobs.filter(left);
  const stop = (job: Process) => {
    const key = keyOf(job);
    setStopping((was) => new Set(was).add(key));
    run(["jobs", job.session, "stop", String(job.pid), String(job.start_us)]).catch((cause: unknown) => {
      setStopping((was) => new Set([...was].filter((each) => each !== key)));
      showToast(`Couldn't stop ${nameOf(job)}: ${errorText(cause)}`, { tone: "error" });
    });
  };
  const stopButton = (job: Process) => (
    <TooltipIconButton tooltip="Stop" aria-label={`Stop ${nameOf(job)}`} size="icon-xs" className="text-muted-foreground hover:text-foreground" onClick={() => stop(job)}>
      <StopCircle />
    </TooltipIconButton>
  );
  return (
    <CardSection
      title="Background processes"
      fold="background"
      count={jobs.length}
      end={
        ran && (
          <TooltipIconButton tooltip="Background history" size="icon-xs" onClick={() => openBackgroundHistory(owner)}>
            <Clock />
          </TooltipIconButton>
        )
      }
    >
      <Rows items={jobs.filter((job) => !left(job))}>
        {(job) => (
          <Line
            key={keyOf(job)}
            icon={job.owner ? <WorkerGlyph id={job.owner.id} /> : <Terminal />}
            title={`${nameOf(job)}\n${[...portsOf(job), job.owner?.name ?? "This session"].join(", ")}`}
            end={<span className="max-w-20 truncate">{job.owner?.name ?? "This session"}</span>}
            action={
              <span className="flex items-center gap-1.5 text-label text-muted-foreground tabular-nums">
                {ranFor(job, now)}
                {stopButton(job)}
              </span>
            }
          >
            <span className="flex min-w-0">
              <span className="truncate">{nameOf(job)}</span>
              {portsOf(job).length > 0 && <span className="max-w-3/4 shrink-0 truncate whitespace-pre text-muted-foreground tabular-nums"> · {portsOf(job).join(", ")}</span>}
            </span>
          </Line>
        )}
      </Rows>
      {leftover.length > 0 && (
        <div role="group" aria-label="Left by finished workers" className="mt-1 flex min-w-0 flex-col">
          <Line
            icon={<Warning />}
            className="text-warning"
            end={
              <button type="button" className="shrink-0 cursor-pointer rounded-sm text-link hover:underline focus-visible:focus-ring" onClick={() => leftover.forEach(stop)}>
                Stop all
              </button>
            }
          >
            {leftover.length} left by finished workers
          </Line>
          <Rows items={leftover}>
            {(job) => (
              <Line
                key={keyOf(job)}
                icon={<WorkerGlyph id={job.owner!.id} />}
                title={`${job.label}\n${job.owner!.name}, ${ranFor(job, now)}`}
                end={
                  <>
                    <span className="max-w-20 truncate">{job.owner!.name}</span>
                    {stopButton(job)}
                  </>
                }
              >
                {job.label}
              </Line>
            )}
          </Rows>
        </div>
      )}
    </CardSection>
  );
}
