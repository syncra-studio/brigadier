import { useState } from "react";

import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { showToast } from "../components/toast";
import { type Job, useDaemon } from "../daemon";
import { StopCircle, Terminal } from "../icons";
import { Clock } from "../landing/icons";
import { errorText, run } from "../onboarding/api";
import { duration, useSecond } from "../thread/words";
import { CardSection } from "./card";
import { openBackgroundHistory } from "./open";
import { Line } from "./source/rows";

const NONE: readonly Job[] = [];
const keyOf = (job: Job) => `${job.pid}.${job.start_us}`;

/**
 * The card's Background section [D73, D105], as the old app's Activities: what the session's ended turns left running
 * (a dev server, a watcher), each with how long it has run and Stop on hover. Stopped, a row goes at once; Rust's row
 * confirms it, and a failed stop brings it back with a toast. As the old one: no section until something has run, then
 * its title keeps the clock that opens Background history, and folds it while something runs [D200].
 */
export function BackgroundCard({ owner }: { owner: string }) {
  const row = useDaemon().rows?.find((each) => each.id === owner);
  const jobs = row?.background ?? NONE;
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const shown = jobs.filter((job) => !stopping.has(keyOf(job)));
  const now = useSecond(shown.length > 0);
  if (shown.length === 0 && !row?.background_ran) return null;
  const stop = (job: Job) => {
    const key = keyOf(job);
    setStopping((was) => new Set(was).add(key));
    run(["jobs", owner, "stop", String(job.pid), String(job.start_us)]).catch((cause: unknown) => {
      setStopping((was) => new Set([...was].filter((each) => each !== key)));
      showToast(`Couldn't stop ${job.label}: ${errorText(cause)}`, { tone: "error" });
    });
  };
  return (
    <CardSection
      title="Background"
      fold="background"
      count={shown.length}
      end={
        <TooltipIconButton tooltip="Background history" size="icon-xs" onClick={() => openBackgroundHistory(owner)}>
          <Clock />
        </TooltipIconButton>
      }
    >
      {shown.length > 0 && shown.map((job) => (
        <div key={keyOf(job)} data-slot="background-job" className="group/row relative min-w-0" title={job.label}>
          <Line icon={<Terminal />} end={<span className="group-hover/row:invisible group-has-focus-visible/row:invisible">{duration(now - job.start_us / 1000)}</span>}>
            {job.label}
          </Line>
          <span
            data-slot="summary-row-action"
            className={cx(
              "row-backing pointer-events-none absolute inset-y-0 end-0 flex items-center ps-4 opacity-0 transition-opacity",
              "group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-has-focus-visible/row:pointer-events-auto group-has-focus-visible/row:opacity-100",
            )}
          >
            <TooltipIconButton tooltip="Stop" aria-label={`Stop ${job.label}`} className="shrink-0 rounded-icon-button text-row-foreground hover:text-foreground" onClick={() => stop(job)}>
              <StopCircle />
            </TooltipIconButton>
          </span>
        </div>
      ))}
    </CardSection>
  );
}
