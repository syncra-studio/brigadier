import { memo, type ReactNode } from "react";

import type { FileChange, Item, Progress, Turn, Work } from "./item";
import { workKey, type Gap, type Group, type Line } from "./lines";
import { useKept } from "./kept";
import { Markdown } from "./markdown";
import { groupWords, useSecond, workWords } from "./words";
import "./markdown.css";

/** Lines of a long output drawn until the user asks for all of it. */
const TAIL_LINES = 400;

const PROGRESS: Record<Progress, string> = {
  pending: "Waiting",
  running: "Running",
  done: "",
  failed: "Failed",
  cancelled: "Cancelled",
};

const GAPS: Record<Gap, string> = { first: "pt-8", turn: "pt-6", part: "pt-4", step: "pt-1" };

export type LineProps = Line & { onToggle: (id: string) => void };

/**
 * The one place a line becomes a row component: the kit's thread rows plug in here. The list owns the column and
 * the space above each row; a row draws only its content. Rows draw again only when one of their props changes.
 */
export const LineRow = memo(function LineRow(props: LineProps) {
  return (
    <div className={`mx-auto w-full max-w-reading px-6 ${GAPS[props.gap]}`} data-item={props.id}>
      {props.type === "work" ? (
        <WorkRow turn={props.turn} work={props.work} open={props.open} onToggle={props.onToggle} />
      ) : props.type === "group" ? (
        <GroupRow item={props.item} live={props.live} open={props.open} onToggle={props.onToggle} />
      ) : (
        <Body item={props.item} />
      )}
    </div>
  );
});

/** "Worked for 3m 4s ›", opening the turn's folded work; "Working for 12s" while it runs. */
function WorkRow({ turn, work, open, onToggle }: { turn: Turn; work: Work | undefined; open: boolean | null; onToggle: (id: string) => void }) {
  const now = useSecond(turn.status === "running");
  const words = workWords(turn, work, now);
  if (open === null) return <p className="border-b border-divider pb-2 text-sm text-muted-foreground tabular-nums">{words}</p>;
  return (
    <button type="button" aria-expanded={open} className="flex w-full items-center gap-1 border-b border-divider pb-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => onToggle(workKey(turn.id))}>
      {words}
      <span className={open ? "rotate-90" : ""}>›</span>
    </button>
  );
}

/** One row for steps that came one after another; while its turn runs, the running step's words. */
function GroupRow({ item, live, open, onToggle }: { item: Group; live: Item | undefined; open: boolean; onToggle: (id: string) => void }) {
  const running = live?.kind === "tool" && live.progress === "running";
  return (
    <button type="button" aria-expanded={open} className="flex max-w-full min-w-0 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" onClick={() => onToggle(item.id)}>
      <span className="truncate">{running ? `Running ${live.input}` : groupWords(item.steps)}</span>
      <span className={open ? "rotate-90" : ""}>›</span>
    </button>
  );
}

function Body({ item }: { item: Item }) {
  switch (item.kind) {
    case "group":
      return null;
    case "message":
      if (item.origin === "system") return <p className="text-center text-xs whitespace-pre-wrap text-muted-foreground">{item.text}</p>;
      if (item.role === "user") {
        return (
          <div className="flex justify-end">
            <p className="max-w-7/10 rounded-overlay bg-muted px-4 py-2.5 text-base whitespace-pre-wrap">{item.text}</p>
          </div>
        );
      }
      return <Markdown text={item.text} keep={item.id} />;
    case "reasoning":
      return (
        <Activity keep={item.id} summary={item.streaming ? "Thinking…" : "Thought"} open={item.streaming}>
          <p className="whitespace-pre-wrap">{item.text}</p>
        </Activity>
      );
    case "tool":
      return (
        <Activity
          keep={item.id}
          open={item.progress === "running"}
          summary={
            <>
              <span className="truncate font-mono text-code">{item.input}</span>
              <State progress={item.progress} />
            </>
          }
        >
          <Output keep={item.id} text={item.output} />
        </Activity>
      );
    case "fileChange":
      return (
        <div className="flex flex-col gap-2">
          {item.changes.map((change, at) => (
            <Diff key={change.path + at} change={change} keep={`${item.id}:${at}`} />
          ))}
        </div>
      );
    case "approval":
      return (
        <Card>
          <p className="font-medium">{item.title}</p>
          <p className="text-muted-foreground">{item.detail}</p>
          <p className={item.decision === "denied" ? "text-destructive" : "text-muted-foreground"}>
            {item.decision === null ? "Waiting for you" : item.decision === "approved" ? "Approved" : "Denied"}
          </p>
        </Card>
      );
    case "question":
      return (
        <Card>
          <p className="font-medium">{item.question}</p>
          <div className="flex flex-wrap gap-2">
            {item.options.map((option) => (
              <span key={option} className={`rounded-capsule border border-border px-3 py-1 ${option === item.answer ? "bg-muted" : ""}`}>
                {option}
              </span>
            ))}
          </div>
        </Card>
      );
    case "childAgent":
      return (
        <p className="flex min-w-0 gap-1.5 text-sm text-muted-foreground">
          <span className="truncate">Agent · {item.title}</span>
          <State progress={item.progress} />
        </p>
      );
    case "compaction":
      return (
        <Activity keep={item.id} summary="Context compacted">
          <p className="whitespace-pre-wrap">{item.summary ?? "No summary"}</p>
        </Activity>
      );
    case "notice":
      return (
        <p className={`text-sm ${item.level === "error" ? "text-destructive" : item.level === "warning" ? "text-warning" : "text-muted-foreground"}`}>
          {item.text}
        </p>
      );
    case "unknown":
      return (
        <Activity keep={item.id} summary="Event Brigadier can't show yet">
          <Output keep={item.id} text={JSON.stringify(item.raw, null, 2)} />
        </Activity>
      );
  }
}

/** A row that opens: one muted line, its detail under it. */
function Activity({ keep, summary, open: initial = false, children }: { keep: string; summary: ReactNode; open?: boolean; children: ReactNode }) {
  const [open, setOpen] = useKept(keep, initial);
  return (
    <div className="flex flex-col text-sm text-muted-foreground">
      <button type="button" className="flex w-fit max-w-full min-w-0 items-center gap-1.5 text-start hover:text-foreground" onClick={() => setOpen(!open)}>
        <span className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}>›</span>
        {summary}
      </button>
      {open && <div className="flex min-w-0 flex-col gap-1 ps-4 pt-1">{children}</div>}
    </div>
  );
}

function State({ progress }: { progress: Progress }) {
  if (!PROGRESS[progress]) return null;
  return <span className={`shrink-0 ${progress === "failed" ? "text-destructive" : ""}`}>{PROGRESS[progress]}</span>;
}

function Card({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-1.5 rounded-surface border border-border bg-card p-3 text-sm">{children}</div>;
}

/** Exact text in a quiet box that scrolls; a long one shows only its end until asked. */
function Output({ keep, text }: { keep: string; text: string }) {
  const [all, setAll] = useKept(`${keep}:all`);
  const lines = text.split("\n");
  const cut = !all && lines.length > TAIL_LINES;
  return (
    <div className="flex flex-col rounded-control bg-code-surface text-foreground">
      {cut && (
        <button type="button" className="self-start px-3 pt-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => setAll(true)}>
          Show all {lines.length.toLocaleString()} lines
        </button>
      )}
      <pre className="max-h-60 overflow-auto px-3 py-2 font-mono text-code whitespace-pre-wrap">
        {cut ? lines.slice(-TAIL_LINES).join("\n") : text}
      </pre>
    </div>
  );
}

/** Lines a diff shows before it folds; only those are drawn. */
const FOLDED_DIFF_LINES = 12;
/** A unified diff's file header, which isn't a change. */
const HEADER = /^(\+\+\+|---) /;

function lineTone(line: string): string {
  if (HEADER.test(line) || line.startsWith("@@")) return "text-muted-foreground";
  if (line.startsWith("+")) return "bg-success-wash text-success";
  if (line.startsWith("-")) return "bg-destructive-wash text-destructive";
  return "";
}

function Diff({ change, keep }: { change: FileChange; keep: string }) {
  const [open, setOpen] = useKept(keep);
  const lines = change.diff.split("\n");
  const added = lines.filter((line) => line.startsWith("+") && !HEADER.test(line)).length;
  const removed = lines.filter((line) => line.startsWith("-") && !HEADER.test(line)).length;
  const long = lines.length > FOLDED_DIFF_LINES;
  return (
    <div className="flex flex-col overflow-hidden rounded-surface border border-border bg-code-surface">
      <div className="flex items-center gap-2 px-3 py-2 text-sm">
        <span className="min-w-0 truncate font-mono text-code">{change.path}</span>
        <span className="text-success">+{added}</span>
        <span className="text-destructive">−{removed}</span>
        {long && (
          <button type="button" className="ms-auto text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)}>
            {open ? "Collapse" : "Expand"}
          </button>
        )}
      </div>
      <pre className="overflow-x-auto pb-2 font-mono text-code">
        {(long && !open ? lines.slice(0, FOLDED_DIFF_LINES) : lines).map((line, at) => (
          <div key={at} className={`px-3 ${lineTone(line)}`}>
            {line || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}
