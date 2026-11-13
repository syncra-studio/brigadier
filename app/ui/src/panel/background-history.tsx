import { useEffect, useState } from "react";

import { Button } from "../components/button";
import { Timeline } from "../components/timeline";
import { useDaemon } from "../daemon";
import { errorText, run } from "../onboarding/api";
import { duration, useSecond } from "../thread/words";

/** One background run as `jobs <id> history` gives it [D200]. */
type Run = { label: string; startedAt: number; endedAt: number | null; status: "running" | "stopped" | "ended" | "unknown" };

const OUTCOME: Record<Run["status"], string> = { running: "Running", stopped: "Stopped by you", ended: "Ended", unknown: "End not observed" };

/**
 * The card's Background history, the old app's HistoryTab [D200]: everything that ran in the session's background on its
 * timeline, newest first, each with how it ended and how long it ran. Read again as the session's jobs start and end.
 */
export function BackgroundHistory({ owner }: { owner: string }) {
  const row = useDaemon().rows?.find((each) => each.id === owner);
  const jobs = (row?.background ?? []).map((job) => `${job.pid}.${job.start_us}`).join(" ");
  const [history, setHistory] = useState<{ runs: Run[] | null; error: string | null; busy: boolean }>({ runs: null, error: null, busy: true });
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    setHistory((was) => ({ ...was, busy: true }));
    run(["jobs", owner, "history"]).then(
      (reply) => live && setHistory({ runs: reply.history as Run[], error: null, busy: false }),
      (cause: unknown) => live && setHistory((was) => ({ ...was, error: errorText(cause), busy: false })),
    );
    return () => {
      live = false;
    };
  }, [owner, jobs, row?.background_ran, tries]);
  const runs = history.runs ?? [];
  const now = useSecond(runs.some((each) => each.status === "running"));
  return (
    <div data-slot="background-history" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-reading flex-col gap-5 px-5 pt-6 pb-10">
        <h2 className="text-sm font-medium">
          Everything that ran this session{history.runs && ` · ${runs.length}`}
        </h2>
        {!history.runs && !history.error && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading background history…
          </p>
        )}
        {history.runs && runs.length === 0 && <p className="text-sm text-muted-foreground">Background commands will appear here once one runs.</p>}
        {history.error && (
          <div role="alert" className="flex items-center gap-2 text-sm">
            <p className="text-destructive">Couldn't load background history: {history.error}</p>
            <Button size="xs" variant="ghost" disabled={history.busy} onClick={() => setTries((n) => n + 1)}>
              Retry
            </Button>
          </div>
        )}
        <Timeline
          events={runs.map((each, index) => ({
            id: `${each.startedAt}.${index}`,
            when: each.status === "running" ? "now" : "past",
            time: new Date(each.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            title: <span title={each.label}>{each.label}</span>,
            detail: [OUTCOME[each.status], took(each, now), new Date(each.startedAt).toLocaleDateString()].join(" · "),
          }))}
        />
      </div>
    </div>
  );
}

function took(each: Run, now: number): string {
  if (each.endedAt !== null) return duration(each.endedAt - each.startedAt);
  if (each.status === "running") return `${duration(now - each.startedAt)} so far`;
  return "Duration unknown";
}
