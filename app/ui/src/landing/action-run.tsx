import { type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "../components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { ConfirmDialog } from "../components/confirm-dialog";
import { cx } from "../components/cx";
import { EmptyState } from "../components/empty-state";
import { ErrorLine } from "../components/error-line";
import { showToast } from "../components/toast";
import { ask, useDaemon } from "../daemon";
import { ArrowLeft, Check, CheckCircle, ChevronRight, type IconProps, InfoCircle, PlayCircle, Spinner, StopCircle, Warning } from "../icons";
import { addChip, useChips } from "../panel/chips";
import { useSecond } from "../thread/words";
import type { AgentChip } from "./agent-chip";
import { useHost } from "./host";
import { Clock, Sparkles, XCircle } from "./icons";
import { CheckAgain } from "./pr-parts";
import { ago, duration as short, FRESH_MS } from "./pr-words";

/*
 * A run's page in the Actions tab, and what the tab's list shares with it [D264]: GitHub's run page without the job
 * graph. Rust reads and keeps it (`host <id> run|job-log|rerun`); this draws it.
 */

export type RunState = "success" | "failure" | "cancelled" | "skipped" | "action_required" | "neutral" | "running" | "queued";
export type Run = {
  id: number;
  title: string;
  workflow: string;
  number: number;
  attempt: number;
  event: string;
  actor: string | null;
  branch: string | null;
  sha: string;
  commit: string | null;
  pr: number | null;
  state: RunState;
  createdAtMs: number | null;
  startedAtMs: number | null;
  durationMs: number | null;
  url: string;
};
export type Workflow = { id: number; name: string; path: string };
export type Found = {
  query: string;
  okAt: number | null;
  error: string | null;
  total: number | null;
  runs: Run[];
};
export type Step = {
  number: number;
  name: string;
  state: RunState;
  startedAtMs: number | null;
  completedAtMs: number | null;
};
export type Job = {
  id: number;
  name: string;
  state: RunState;
  startedAtMs: number | null;
  completedAtMs: number | null;
  steps: Step[];
};
export type Annotation = {
  job: string;
  level: "failure" | "warning" | "notice" | null;
  title: string | null;
  message: string;
  path: string | null;
  line: number | null;
};
export type RunRead = {
  run: Run;
  jobs: Job[];
  annotations: Annotation[];
  okAt: number | null;
  error: string | null;
};
export type LogLine = {
  text: string;
  kind?: "error" | "warning" | "notice" | "command" | "debug";
  group?: LogLine[];
};

/** Proposed: a run still going is read again this often while its page is open. */
const LIVE_MS = 10_000;

export const STATES: Record<RunState, { Icon: ComponentType<IconProps>; tint: string; words: string }> = {
  success: { Icon: CheckCircle, tint: "text-success", words: "Success" },
  failure: { Icon: XCircle, tint: "text-destructive", words: "Failure" },
  cancelled: {
    Icon: StopCircle,
    tint: "text-muted-foreground",
    words: "Cancelled",
  },
  skipped: {
    Icon: StopCircle,
    tint: "text-muted-foreground",
    words: "Skipped",
  },
  action_required: {
    Icon: Warning,
    tint: "text-warning",
    words: "Action required",
  },
  neutral: {
    Icon: CheckCircle,
    tint: "text-muted-foreground",
    words: "Neutral",
  },
  running: { Icon: Spinner, tint: "text-pr-yellow", words: "In progress" },
  queued: { Icon: Clock, tint: "text-pr-yellow", words: "Queued" },
};

export function StateIcon({ state, size = "size-icon-md" }: { state: RunState; size?: string }) {
  const { Icon, tint, words } = STATES[state];
  return <Icon aria-label={words} className={cx(size, "shrink-0", tint, state === "running" && "animate-spin motion-reduce:animate-none")} />;
}

/** "12s", "4m 05s", then "3h 20m" and "2d 4h": a run can wait days for an approval. */
export const duration = (ms: number) =>
  ms < 3_600_000 ? short(ms) : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)}h ${Math.floor(ms / 60_000) % 60}m` : `${Math.floor(ms / 86_400_000)}d ${Math.floor(ms / 3_600_000) % 24}h`;
export const plural = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? "" : "s"}`;

/** A run's wait or length: done, as GitHub kept it; going, from its start until now. */
export const lasted = (run: Run, now: number) => run.durationMs ?? (run.startedAtMs !== null && (run.state === "running" || run.state === "queued") ? now - run.startedAtMs : null);
export const Ref = ({ children }: { children: ReactNode }) => <span className="max-w-48 truncate rounded-control bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{children}</span>;

/** Re-run all its jobs or only the failed ones, on GitHub, once asked [D264]. */
export function useRerun(owner: string, onDone: () => void) {
  const host = useHost(owner);
  const [asking, setAsking] = useState<{ run: Run; failed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = (
    <ConfirmDialog
      open={asking !== null}
      onOpenChange={(open) => !open && setAsking(null)}
      title={asking && (asking.failed ? "Re-run failed jobs?" : "Re-run all jobs?")}
      description={asking && `${asking.run.workflow} #${asking.run.number} runs ${asking.failed ? "its failed jobs, and the jobs they need," : "every job"} again on GitHub.`}
      confirm={asking?.failed ? "Re-run failed jobs" : "Re-run all jobs"}
      busy={busy}
      onConfirm={() => {
        if (!asking) return;
        setBusy(true);
        ask(
          {
            op: "run",
            args: ["host", host, "rerun", String(asking.run.id), asking.failed ? "failed" : "all"],
          },
          (reply) => {
            setBusy(false);
            setAsking(null);
            if (!reply.ok) return void showToast(`Couldn't re-run · ${String(reply.error).split("\n")[0]}`, { tone: "error" });
            showToast(`Re-running ${asking.run.workflow} #${asking.run.number}`);
            onDone();
          },
        );
      }}
    />
  );
  return {
    dialog,
    rerun: (run: Run, failed: boolean) => setAsking({ run, failed }),
  };
}

/** Send to agent on a failed run: a chip above the composer, sent with the user's next message [D261, D1027]. */
export function useSend(owner: string) {
  const chips = useChips(owner);
  const added = (run: Run) => chips.some((chip) => chip.kind === "agent" && chip.key === `run:${run.id}`);
  const send = (run: Run, failed: string[]) => {
    if (added(run)) return;
    const name = `${run.workflow} #${run.number}`;
    const chip: AgentChip = {
      id: `run:${run.id}`,
      kind: "run",
      run: name,
      failed: failed.length ? `${failed.join(", ")} failed` : "The run failed",
    };
    const text = `Fix the failed workflow run ${name} (${run.url}) on ${run.branch ?? "its branch"} at ${run.sha.slice(0, 7)}. ${failed.length ? `Its failed jobs: ${failed.join(", ")}.` : ""}`.trim();
    addChip(owner, {
      kind: "agent",
      id: crypto.randomUUID(),
      key: `run:${run.id}`,
      pr: null,
      chip,
      text,
    });
  };
  return { added, send };
}

const SUMMARY = "flex min-w-0 flex-col gap-1";
const LABEL = "text-xs text-muted-foreground";

/**
 * A run's page as GitHub's, without the graph [D264]: back to its workflow, its title and #N with its state, Re-run;
 * the summary bar; annotations; then its jobs, each opening its steps and, once done, its log. A run still going is read
 * again every few seconds; a running job shows its steps' states only, as GitHub has no public live log.
 */
export function RunPage({ owner, first, onBack }: { owner: string; first: Run; onBack: () => void }) {
  const host = useHost(owner);
  const { daemon } = useDaemon();
  const [page, setPage] = useState<RunRead>({
    run: first,
    jobs: [],
    annotations: [],
    okAt: null,
    error: null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const sends = useSend(owner);
  const run = page.run;
  const going = run.state === "running" || run.state === "queued";
  const now = useSecond(going);
  const reading = useRef(false);
  const read = () => {
    if (reading.current) return;
    reading.current = true;
    setBusy(true);
    ask({ op: "run", args: ["host", host, "run", String(first.id)] }, (reply) => {
      reading.current = false;
      setBusy(false);
      setLoaded(true);
      if (reply.ok) setPage(reply.run);
      setError(reply.ok ? null : String(reply.error));
    });
  };
  useEffect(() => {
    if (!daemon) return;
    ask({ op: "run", args: ["host", host, "run", String(first.id), "kept"] }, (reply) => {
      if (reply.ok && reply.run) {
        setPage(reply.run);
        setLoaded(true);
      }
      if (Date.now() - (reply.run?.okAt ?? 0) > FRESH_MS) read();
    });
  }, [daemon, host, first.id]);
  useEffect(() => {
    if (!daemon || !going) return;
    const every = setInterval(read, LIVE_MS);
    return () => clearInterval(every);
  }, [daemon, going]);
  const { dialog, rerun } = useRerun(owner, read);

  const failedJobs = page.jobs.filter((job) => job.state === "failure").map((job) => job.name);
  const failed = run.state === "failure";
  const took = lasted(run, now);
  return (
    <div data-slot="actions-run" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex w-full flex-col gap-5 p-5">
        <header className="flex flex-col gap-2.5">
          <Button variant="link-blue" size="inline" className="self-start" onClick={onBack}>
            <ArrowLeft />
            {run.workflow}
          </Button>
          <div className="flex min-h-control-sm items-start gap-2">
            <StateIcon state={run.state} size="size-icon-lg mt-1" />
            <h2 className="min-w-0 flex-1 font-display text-lg font-medium">
              {run.title} <span className="font-normal text-muted-foreground">#{run.number}</span>
            </h2>
            <CheckAgain busy={busy} offline={!daemon} onClick={read} />
            {failed && (
              <Button size="sm" variant="soft" disabled={sends.added(run) || !daemon} onClick={() => sends.send(run, failedJobs)}>
                {sends.added(run) ? <Check /> : <Sparkles />}
                {sends.added(run) ? "Added" : "Send to agent"}
              </Button>
            )}
            {failed && (
              <Button size="sm" variant="soft" disabled={!daemon} onClick={() => rerun(run, true)}>
                Re-run failed jobs
              </Button>
            )}
            <Button size="sm" variant="soft" disabled={!daemon || going} onClick={() => rerun(run, false)}>
              Re-run all jobs
            </Button>
          </div>
          <ErrorLine error={error ?? page.error} />
        </header>
        <div className="flex flex-wrap gap-x-12 gap-y-3 rounded-surface border border-border px-4 py-3 text-sm">
          <div className={SUMMARY}>
            <span className={LABEL}>
              Triggered via {run.event.replaceAll("_", " ")} {run.createdAtMs !== null && ago(run.createdAtMs, now)}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              {run.actor && <span className="font-medium">{run.actor}</span>}
              <Ref>{run.sha.slice(0, 7)}</Ref>
              {run.branch && <Ref>{run.branch}</Ref>}
            </span>
          </div>
          <div className={SUMMARY}>
            <span className={LABEL}>Status</span>
            <span className="flex items-center gap-1.5">{STATES[run.state].words}</span>
          </div>
          <div className={SUMMARY}>
            <span className={LABEL}>Total duration</span>
            <span className="tabular-nums">{took !== null ? duration(took) : "–"}</span>
          </div>
          {run.attempt > 1 && (
            <div className={SUMMARY}>
              <span className={LABEL}>Attempt</span>
              <span className="tabular-nums">#{run.attempt}</span>
            </div>
          )}
        </div>
        {page.annotations.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Annotations</h3>
            <ul className="flex flex-col overflow-clip rounded-surface border border-border">
              {page.annotations.map((a, i) => (
                <li key={i} className="flex items-start gap-2.5 border-b border-border px-4 py-2.5 text-sm last:border-b-0">
                  {a.level === "failure" ? (
                    <XCircle className="mt-0.5 size-icon-sm shrink-0 text-destructive" />
                  ) : a.level === "warning" ? (
                    <Warning className="mt-0.5 size-icon-sm shrink-0 text-warning" />
                  ) : (
                    <InfoCircle className="mt-0.5 size-icon-sm shrink-0 text-muted-foreground" />
                  )}
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium">{a.job}</span>
                    <span className="break-words text-muted-foreground">{a.title ? `${a.title}: ${a.message}` : a.message}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Jobs</h3>
          <ul className="flex flex-col overflow-clip rounded-surface border border-border">
            {page.jobs.map((job) => (
              <JobRow key={job.id} owner={owner} job={job} now={now} />
            ))}
            {page.jobs.length === 0 && (
              <li className="px-4 py-6">
                {loaded ? (
                  <EmptyState variant="centered" icon={PlayCircle} title="This run has no jobs" />
                ) : (
                  <p className="text-center text-sm text-muted-foreground">{daemon ? "Loading…" : "Reconnecting…"}</p>
                )}
              </li>
            )}
          </ul>
        </section>
      </div>
      {dialog}
    </div>
  );
}

const span = (start: number | null, end: number | null, now: number) => (start === null ? null : (end ?? now) - start);

/** A job: its state, name and time; opened, its steps and, once it's done, its log. */
function JobRow({ owner, job, now }: { owner: string; job: Job; now: number }) {
  const [open, setOpen] = useState(false);
  const done = job.state !== "running" && job.state !== "queued";
  const took = span(job.startedAtMs, job.completedAtMs, now);
  return (
    <li className="border-b border-border last:border-b-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2.5 px-4 py-2.5 text-start text-sm hover:bg-fill-subtle focus-visible:focus-ring">
          <ChevronRight className={cx("size-icon-sm shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <StateIcon state={job.state} size="size-icon-sm" />
          <span className="min-w-0 flex-1 truncate font-medium">{job.name}</span>
          {took !== null && job.state !== "skipped" && <span className="text-xs text-muted-foreground tabular-nums">{duration(took)}</span>}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-2 px-4 pb-3">
            <ol className="flex flex-col">
              {job.steps.map((step) => {
                const t = span(step.startedAtMs, step.completedAtMs, now);
                return (
                  <li key={step.number} className="flex h-control-sm items-center gap-2.5 ps-6 text-sm">
                    <StateIcon state={step.state} size="size-icon-sm" />
                    <span className="min-w-0 flex-1 truncate">{step.name}</span>
                    {t !== null && step.state !== "skipped" && <span className="text-xs text-muted-foreground tabular-nums">{duration(t)}</span>}
                  </li>
                );
              })}
            </ol>
            {open && (done ? <JobLog owner={owner} job={job.id} /> : <p className="ps-6 text-xs text-muted-foreground">Its log shows once the job finishes.</p>)}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/** A finished job's log, read once and kept by Rust; its `##[group]` lines fold as GitHub's do. */
function JobLog({ owner, job }: { owner: string; job: number }) {
  const host = useHost(owner);
  const [log, setLog] = useState<{ lines: LogLine[]; cut: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    ask({ op: "run", args: ["host", host, "job-log", String(job)] }, (reply) => (reply.ok ? setLog(reply.log) : setError(String(reply.error))));
  }, [host, job]);
  if (error) return <ErrorLine error={`Couldn't read the log · ${error.split("\n")[0]}`} />;
  if (!log) return <p className="ps-6 text-xs text-muted-foreground">Reading the log…</p>;
  return (
    <div className="overflow-x-auto rounded-control bg-feedback-field px-3 py-2 font-mono text-xs leading-5 text-muted-foreground">
      {log.cut > 0 && <p className="italic">{plural(log.cut, "earlier line")} not shown</p>}
      {log.lines.map((line, i) => (
        <LogRow key={i} line={line} />
      ))}
    </div>
  );
}

const KINDS = {
  error: "text-destructive",
  warning: "text-warning",
  notice: "text-foreground",
  command: "text-link",
  debug: "text-quiet-foreground",
};

function LogRow({ line }: { line: LogLine }) {
  if (!line.group) return <p className={cx("whitespace-pre-wrap break-all", line.kind && KINDS[line.kind])}>{line.text || " "}</p>;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-start text-foreground focus-visible:focus-ring">
        <ChevronRight className="size-icon-xs shrink-0 transition-transform group-data-panel-open:rotate-90" />
        {line.text}
      </CollapsibleTrigger>
      <CollapsibleContent className="ps-4">
        {line.group.map((inner, i) => (
          <LogRow key={i} line={inner} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
