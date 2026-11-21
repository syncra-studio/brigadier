import { useState } from "react";

import { TooltipIconButton } from "../components/icon-button";
import { showToast } from "../components/toast";
import { type Job, useDaemon } from "../daemon";
import { StopCircle, Terminal } from "../icons";
import { Clock } from "../landing/icons";
import { errorText, run } from "../onboarding/api";
import { duration, useSecond } from "../thread/words";
import { CardSection } from "./card";
import { openBackgroundHistory } from "./open";
import { Line, Rows } from "./source/rows";

const NONE: readonly Job[] = [];
const keyOf = (job: Job) => `${job.pid}.${job.start_us}`;

/**
 * The card's Background processes, plain rows with our extras [D145, D73, D105]: what the session's ended turns
 * left running (a dev server, a watcher), each with how long it has run and Stop on hover. Stopped, a row goes at once;
 * Rust's row confirms it, and a failed stop brings it back with a toast. No section until something has run, then its
 * title keeps the clock that opens Background history [D200].
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
      title="Background processes"
      fold="background"
      count={shown.length}
      end={
        <TooltipIconButton tooltip="Background history" size="icon-xs" onClick={() => openBackgroundHistory(owner)}>
          <Clock />
        </TooltipIconButton>
      }
    >
      <Rows items={shown}>
        {(job) => (
          <Line
            key={keyOf(job)}
            icon={<Terminal />}
            title={job.label}
            end={duration(now - job.start_us / 1000)}
            action={
              <TooltipIconButton tooltip="Stop" aria-label={`Stop ${job.label}`} size="icon-xs" className="text-muted-foreground hover:text-foreground" onClick={() => stop(job)}>
                <StopCircle />
              </TooltipIconButton>
            }
          >
            {job.label}
          </Line>
        )}
      </Rows>
    </CardSection>
  );
}
