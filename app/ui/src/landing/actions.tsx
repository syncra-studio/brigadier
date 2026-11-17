import { useEffect, useState } from "react";
import { Button } from "../components/button";
import { EmptyState } from "../components/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/menu";
import { NavRow } from "../components/nav";
import { ask, useDaemon } from "../daemon";
import { Check, DotsHorizontal, PlayCircle } from "../icons";
import { openPr } from "../panel/open";
import { Note } from "../panel/source/rows";
import { SelectTrigger } from "../components/select";
import { SearchField } from "../settings/archived-toolbar";
import { useSecond } from "../thread/words";
import { type Found, lasted, Ref, type Run, RunPage, StateIcon, duration, plural, useRerun, useSend, type Workflow } from "./action-run";
import { useHost } from "./host";
import { Sparkles } from "./icons";
import { CheckAgain } from "./pr-parts";
import { ago, FRESH_MS } from "./pr-words";

/*
 * The Actions tab [D264]: GitHub's All workflows page from our kit, then a run's page in the same tab, without the
 * job graph. Rust reads and keeps it all (`host <id> runs|run|job-log|rerun`); this draws it. Each view paints its last
 * read at once and reads again when older than the watch's quickest pace, and on Check again [D207, D208].
 */

const STATUSES = [
  ["queued", "Queued"],
  ["in_progress", "In progress"],
  ["waiting", "Waiting"],
  ["success", "Success"],
  ["failure", "Failure"],
  ["cancelled", "Cancelled"],
  ["skipped", "Skipped"],
  ["action_required", "Action required"],
  ["timed_out", "Timed out"],
].map(([value, label]) => ({ value: `is:${value}`, label }));


/** One of the bar's menus: its pill, then its choices; a pick puts its word in the query. */
function Filter({ label, value, choices, onPick }: { label: string; value?: string; choices: { value: string; label: string }[]; onPick: (word: string) => void }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        render={
          <SelectTrigger label={label} className="border-transparent bg-transparent">
            {label}
          </SelectTrigger>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value ?? ""} onValueChange={onPick}>
          {choices.map((choice) => (
            <DropdownMenuRadioItem key={choice.value} value={choice.value} indicator={<Check className="size-icon-md" />}>
              {choice.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The query's words, a quoted one ("Bump Go") whole, as Rust reads them. */
const tokens = (query: string) => query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
const keyOf = (word: string) => word.split(":")[0].replace(/^status$/, "is");
const wordOf = (query: string, key: string) => tokens(query).find((w) => keyOf(w) === key);
/** The query with `word` in place of the one of its kind; picking the one already there takes it away. */
const withWord = (query: string, word: string) => {
  const rest = tokens(query).filter((w) => keyOf(w) !== keyOf(word));
  return (wordOf(query, keyOf(word)) === word ? rest : [...rest, word]).join(" ");
};
const named = (name: string) => `workflow:${/\s/.test(name) ? `"${name}"` : name}`;

/** "Commit 3d5a9e3 pushed by ana", "Pull request #12 by ana", "Scheduled", as GitHub's runs list says how each began. */
function How({ owner, run }: { owner: string; run: Run }) {
  const by = run.actor ? ` by ${run.actor}` : "";
  if (run.event === "push")
    return (
      <>
        Commit {run.sha.slice(0, 7)} pushed{by}
      </>
    );
  if (run.event === "schedule") return <>Scheduled</>;
  if (run.event === "workflow_dispatch") return <>Manually run{by}</>;
  if (run.event.startsWith("pull_request"))
    return (
      <>
        Pull request{" "}
        {run.pr !== null && (
          <button type="button" className="cursor-pointer text-link hover:underline focus-visible:focus-ring" onClick={() => openPr(owner, { number: run.pr! })}>
            #{run.pr}
          </button>
        )}
        {by}
      </>
    );
  return (
    <>
      {run.event.replaceAll("_", " ")}
      {by}
    </>
  );
}

/** GitHub's runs row: state, title, then "<workflow> #N: how it began"; its branch, when, how long, and ···. */
function Row({ owner, run, now, onOpen, onRerun, sends }: { owner: string; run: Run; now: number; onOpen: () => void; onRerun: (failed: boolean) => void; sends: ReturnType<typeof useSend> }) {
  const took = lasted(run, now);
  const failed = run.state === "failure";
  return (
    <li className="flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0 hover:bg-fill-subtle">
      <span className="flex pt-0.5">
        <StateIcon state={run.state} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <button type="button" onClick={onOpen} className="cursor-pointer truncate text-start text-sm font-medium text-foreground hover:underline focus-visible:focus-ring">
          {run.title}
        </button>
        <span className="truncate text-xs text-muted-foreground">
          <span className="font-medium">
            {run.workflow} #{run.number}
          </span>
          : <How owner={owner} run={run} />
        </span>
      </span>
      {run.branch && <Ref>{run.branch}</Ref>}
      <span className="flex w-24 shrink-0 flex-col items-end gap-0.5 text-xs text-muted-foreground tabular-nums">
        {run.createdAtMs !== null && <span>{ago(run.createdAtMs, now)}</span>}
        {took !== null && <span>{duration(took)}</span>}
      </span>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${run.workflow} #${run.number}`} className="text-quiet-foreground" />}>
          <DotsHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onRerun(false)}>Re-run all jobs</DropdownMenuItem>
          {failed && <DropdownMenuItem onClick={() => onRerun(true)}>Re-run failed jobs</DropdownMenuItem>}
          {failed && (
            <DropdownMenuItem disabled={sends.added(run)} onClick={() => sends.send(run, [])}>
              {sends.added(run) ? <Check /> : <Sparkles />}
              {sends.added(run) ? "Added" : "Send to agent"}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** The Actions tab: the runs list, or the run picked from it, which goes back to the list as it was. */
export function Actions({ owner }: { owner: string }) {
  const [open, setOpen] = useState<Run | null>(null);
  return (
    <>
      <RunList owner={owner} hidden={open !== null} onOpen={setOpen} />
      {open && <RunPage key={open.id} owner={owner} first={open} onBack={() => setOpen(null)} />}
    </>
  );
}

/**
 * GitHub's All workflows page [D264]: the side list (All workflows, then each workflow), Search runs in GitHub's words,
 * "N workflow runs" with Workflow, Event, Status, Branch and Actor. Every side view's last read comes in as the tab
 * opens and the stale ones are read together, so a switch paints at once [D207].
 */
function RunList({ owner, hidden, onOpen }: { owner: string; hidden: boolean; onOpen: (run: Run) => void }) {
  const host = useHost(owner);
  const { daemon } = useDaemon();
  const now = useSecond(!hidden);
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [reads, setReads] = useState<Partial<Record<string, Found>>>({});
  const [reading, setReading] = useState<string[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const found = reads[query] ?? null;
  const sends = useSend(owner);

  const land = (reply: Record<string, any>) => {
    if (reply.workflows?.list) setWorkflows(reply.workflows.list);
    const list: (Found | null)[] = reply.found ?? [];
    setReads((was) => ({
      ...was,
      ...Object.fromEntries(list.filter((f): f is Found => !!f).map((f) => [f.query, f])),
    }));
    return list;
  };
  // One call for all of them; a failed one keeps each last read, and says why.
  const read = (queries: string[], then?: (flows: Workflow[]) => void) => {
    setReading((was) => [...was, ...queries]);
    ask({ op: "run", args: ["host", host, "runs", ...queries] }, (reply) => {
      setReading((was) => was.filter((q) => !queries.includes(q)));
      setFailed(reply.ok ? null : String(reply.error ?? "Couldn't check."));
      if (!reply.ok) return;
      land(reply);
      then?.(reply.workflows?.list ?? []);
    });
  };
  // Their last reads at once, then one read of those older than the watch's quickest pace.
  const bring = (queries: string[], then?: (flows: Workflow[]) => void) =>
    ask({ op: "run", args: ["host", host, "runs", ...queries, "--kept"] }, (reply) => {
      const last = land(reply);
      if (then) return then(reply.workflows?.list ?? []);
      const stale = queries.filter((_, i) => Date.now() - (last[i]?.okAt ?? 0) > FRESH_MS);
      if (stale.length) read(stale);
    });
  const search = (q: string) => {
    setText(q);
    setQuery(q);
    const last = reads[q];
    if (!last) bring([q]);
    else if (Date.now() - (last.okAt ?? 0) > FRESH_MS && !reading.includes(q)) read([q]);
  };

  // As the tab opens, every view's last read, then one read of the stale ones; with no workflows kept yet, the first
  // read brings them and their views are read next.
  const viewsOf = (flows: Workflow[]) => flows.map((w) => named(w.name));
  useEffect(() => {
    if (!daemon) return;
    bring([""], (flows) => (flows.length ? bring(["", ...viewsOf(flows)]) : read([""], (fresh) => read(viewsOf(fresh)))));
  }, [daemon, host]);

  const runs = found?.runs ?? [];
  const busy = reading.includes(query);
  const error = found?.error ?? failed;
  // A search on one workflow is that workflow's view, as GitHub's.
  const flow = workflows?.find((w) => named(w.name) === wordOf(query, "workflow"));
  // Filters offer what the reads held: every event, branch and actor seen in them.
  const seen = (pick: (run: Run) => string | null) => [...new Set(Object.values(reads).flatMap((f) => f?.runs.map(pick) ?? []))].filter((v): v is string => !!v).sort();
  const choices = (key: string, values: string[]) =>
    values.map((v) => ({
      value: `${key}:${/\s/.test(v) ? `"${v}"` : v}`,
      label: v,
    }));
  const refine = (word: string) => search(withWord(query, word));
  const { dialog, rerun } = useRerun(owner, () => read([query]));

  return (
    <div data-slot="actions-list" hidden={hidden} className="flex min-h-0 flex-1 gap-6 overflow-y-auto p-5">
      <nav aria-label="Workflows" className="flex w-52 shrink-0 flex-col gap-0.5">
        <NavRow aria-current={flow ? undefined : "page"} onClick={() => search("")}>
          <PlayCircle className="text-muted-foreground" />
          All workflows
        </NavRow>
        {(workflows ?? []).map((w) => (
          <NavRow key={w.id} title={w.path} aria-current={flow?.id === w.id ? "page" : undefined} onClick={() => search(named(w.name))}>
            <span className="truncate">{w.name}</span>
          </NavRow>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <header className="flex items-baseline gap-3">
          <h2 className="min-w-0 flex-1 truncate font-display text-base font-medium">{flow?.name ?? "All workflows"}</h2>
          <CheckAgain at={found?.okAt ?? null} busy={busy} offline={!daemon} onClick={() => read([query])} />
        </header>
        <form
          className="flex"
          onSubmit={(event) => {
            event.preventDefault();
            search(text.trim());
          }}
        >
          <SearchField label="Filter workflow runs" value={text} onChange={setText} />
        </form>
        {error && <Note warn text={`Couldn't check · ${error.split("\n")[0]}`} />}
        <ul className="flex flex-col overflow-clip rounded-surface border border-border">
          <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-fill-subtle px-4 py-1.5 text-sm">
            <span className="font-medium text-foreground">{found?.total != null ? plural(found.total, "workflow run") : "–"}</span>
            <span className="flex-1" />
            {!flow && (
              <Filter
                label="Workflow"
                value={wordOf(query, "workflow")}
                choices={(workflows ?? []).map((w) => ({
                  value: named(w.name),
                  label: w.name,
                }))}
                onPick={refine}
              />
            )}
            <Filter
              label="Event"
              value={wordOf(query, "event")}
              choices={choices(
                "event",
                seen((r) => r.event),
              )}
              onPick={refine}
            />
            <Filter label="Status" value={wordOf(query, "is")} choices={STATUSES} onPick={refine} />
            <Filter
              label="Branch"
              value={wordOf(query, "branch")}
              choices={choices(
                "branch",
                seen((r) => r.branch),
              )}
              onPick={refine}
            />
            <Filter
              label="Actor"
              value={wordOf(query, "actor")}
              choices={choices(
                "actor",
                seen((r) => r.actor),
              )}
              onPick={refine}
            />
          </li>
          {runs.map((run) => (
            <Row key={run.id} owner={owner} run={run} now={now} sends={sends} onOpen={() => onOpen(run)} onRerun={(failed) => rerun(run, failed)} />
          ))}
          {runs.length === 0 && (
            <li className="px-4 py-10">
              {found ? (
                <EmptyState variant="centered" icon={PlayCircle} title={found.okAt === null ? "Couldn't read the runs" : "No workflow runs match"} />
              ) : (
                <p className="text-center text-sm text-muted-foreground">{!daemon ? "Reconnecting…" : busy ? "Checking…" : "Loading…"}</p>
              )}
            </li>
          )}
        </ul>
      </div>
      {dialog}
    </div>
  );
}
