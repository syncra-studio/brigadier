import { useEffect, useState } from "react";

import { Button } from "../components/button";
import { Timeline } from "../components/timeline";
import { useDaemon } from "../daemon";
import { errorText, run } from "../onboarding/api";
import { useSecond } from "../thread/words";
import { ranWords, RUN_OUTCOME as OUTCOME } from "../../../shared/words";
import { useFamily } from "../workers/live";

/** One background run as `jobs <id> history` gives it [D200]; `owner`: the worker that left it, none the session's own. */
type Run = { owner?: string; label: string; startedAt: number; endedAt: number | null; status: "running" | "stopped" | "ended" | "unknown" };

/**
 * The card's Background history, the old app's HistoryTab [D200]: everything that ran in the background of the session
 * and its workers on its timeline, newest first, each with its worker, how it ended and how long it ran. Read again as
 * their jobs start and end.
 */
export function BackgroundHistory({ owner }: { owner: string }) {
  const row = useDaemon().rows?.find((each) => each.id === owner);
  const rows = [row, ...useFamily(owner).map((each) => each.row)];
  const jobs = rows.flatMap((each) => each?.background ?? []).map((job) => `${job.pid}.${job.start_us}`).join(" ");
  const ran = rows.filter((each) => each?.background_ran).length;
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
  }, [owner, jobs, ran, tries]);
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
            detail: [each.owner, OUTCOME[each.status], ranWords(each, now), new Date(each.startedAt).toLocaleDateString()].filter(Boolean).join(" · "),
          }))}
        />
      </div>
    </div>
  );
}
