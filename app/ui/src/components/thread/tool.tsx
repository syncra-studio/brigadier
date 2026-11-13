import { type ReactNode, useMemo } from "react";

import { Check, Stop } from "../../icons";
import type { Item, Progress, StepKind } from "../../thread/item";
import { useKept } from "../../thread/kept";
import { connectorName } from "../../thread/words";
import type { PendingApproval } from "../composer/approval";
import { Button } from "../button";
import { CopyButton } from "../copy-button";
import { cx } from "../cx";
import { ErrorLine } from "../error-line";
import { DETAIL, OpeningRow, ROW, StepIcon, Words } from "./activity-row";

/** A step's verb while it runs, once done and while it waits to start ("Reading", "Read", "read"), by kind. */
export const VERBS: Record<StepKind, [string, string, string]> = {
  read: ["Reading", "Read", "read"],
  edit: ["Editing", "Edited", "edit"],
  list: ["Listing files in", "Listed files in", "list files in"],
  search: ["Searching for", "Searched for", "search for"],
  run: ["Running", "Ran", "run"],
  web: ["Searching the web for", "Searched the web for", "search the web for"],
  agent: ["Running a subagent:", "Ran a subagent:", "run a subagent:"],
  skill: ["Using", "Used", "use"],
  other: ["Using", "Used", "use"],
};

/** What a step acted on: a command, a path, a query; another tool's own name, an MCP tool's server ("Atlassian"). */
export const toolObject = (kind: StepKind, name: string, input: string, server?: string | null) =>
  kind === "skill" ? skillObject(name, input) : kind === "other" ? (server ? connectorName(server) : name) : input || name;

/** A skill by its name and what it was given: "code-review on" a PR, a bare number read as a PR's or issue's [D211]. */
const skillObject = (name: string, input: string) => `${name || "a skill"}${input ? ` on ${/^\d+$/.test(input) ? `#${input}` : input}` : ""}`;

/** An MCP tool's name as words, as the old app's: "searchJiraIssues" is "search jira issues". */
const actionWords = (name: string) =>
  name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();

/** A running step's words: "Reading blocks.ts", "Running pnpm build". */
export const doingWords = (kind: StepKind, name: string, input: string) => `${VERBS[kind][0]} ${toolObject(kind, name, input)}`;

/** Inside the step it allowed: "Allowed by you", and the agent's reason when it gave one [D173]. */
export function Allowed({ approval }: { approval: PendingApproval }) {
  return (
    <p className="pt-1 text-sm whitespace-pre-wrap wrap-anywhere text-muted-foreground">
      Allowed by you{approval.reason && <span className="text-row-foreground"> · {approval.reason}</span>}
    </p>
  );
}

/** Lines of output drawn until the user asks for all of them: a huge log stays cheap. */
const TAIL_LINES = 400;

/**
 * One tool call: "Ran pnpm test", "Reading blocks.ts" (shimmering while it runs), with its kind's icon.
 * A finished call opens: a command to its Shell box, any other tool to its input and output. A failed
 * tool reads "— failed" (a command's exit code shows in its box); a stopped one "Stopped …"; a queued one
 * "Waiting to run …", still.
 */
export function ToolRow({
  keep,
  kind = "other",
  name,
  input,
  output,
  progress,
  exitCode,
  took,
  server,
  approval,
  log,
}: {
  keep: string;
  kind?: StepKind;
  name: string;
  input: string;
  output: string;
  progress: Progress;
  exitCode: number | null;
  /** How long it took, once done ("in 41s"), or how long it has run. */
  took?: string;
  /** An MCP tool's server: "Atlassian: search jira issues" running, "Used Atlassian" done [D176]. */
  server?: string | null;
  approval?: PendingApproval;
  /** A skill's own steps, drawn under it as they come [D211]. */
  log?: Item[];
}) {
  const command = kind === "run";
  const skill = kind === "skill";
  const steps = log?.map(
    (step) =>
      step.kind === "tool" && (
        <ToolRow key={step.id} keep={step.id} kind={step.step} name={step.name} input={step.input} output={step.output} progress={step.progress} exitCode={step.exitCode} server={step.server} />
      ),
  );
  const object = toolObject(kind, name, input, server);
  const running = progress === "running" || progress === "pending";
  const [doing, done, waiting] = VERBS[kind];
  const words =
    progress === "running" && server ? (
      <Words verb={`${object}:`} object={actionWords(name)} live />
    ) : progress === "pending" ? (
      <Words verb={`Waiting to ${waiting}`} object={object} />
    ) : progress === "cancelled" ? (
      <Words verb="Stopped" object={command ? object : `${doing.toLowerCase()} ${object}`} />
    ) : (
      <Words verb={running ? doing : done} object={progress === "failed" && !command ? `${object} — failed` : object} live={progress === "running"} />
    );
  const head = (
    <>
      <StepIcon kind={kind} icon={progress === "cancelled" ? Stop : undefined} />
      {words}
      {took && <span className="shrink-0 tabular-nums">{took}</span>}
    </>
  );
  // A running step opens only when it's a command: its output shows as it comes. A running skill's steps show under it.
  if (running && !command) {
    if (!steps?.length) return <div className={ROW}>{head}</div>;
    return (
      <div className="flex min-w-0 flex-col">
        <div className={ROW}>{head}</div>
        <div className={cx(DETAIL, "ps-5.5")}>{steps}</div>
      </div>
    );
  }
  if (skill && !steps?.length && !output) return <div className={ROW}>{head}</div>;
  return (
    <OpeningRow
      keep={keep}
      detail={
        <>
          {approval && <Allowed approval={approval} />}
          {skill ? (
            <>
              {steps?.length ? <div className={cx(DETAIL, "ps-5.5")}>{steps}</div> : null}
              {output && <ToolBox title="Output">{output}</ToolBox>}
            </>
          ) : command ? (
            <ShellBox keep={keep} command={object} output={output} progress={progress} exitCode={exitCode} />
          ) : (
            <ToolDetail name={server ? `${object}: ${actionWords(name)}` : name} what={server ? actionWords(name) : "Input"} input={input} output={output} failed={progress === "failed"} />
          )}
        </>
      }
    >
      {head}
    </OpeningRow>
  );
}

/** A command's box: "Shell", the command (two lines until clicked), its newest output, how it ended. */
export function ShellBox({
  keep,
  command,
  output,
  progress,
  exitCode,
}: {
  keep: string;
  command: string;
  output: string;
  progress: Progress;
  exitCode: number | null;
}) {
  const [whole, setWhole] = useKept(`${keep}:command`);
  const ending =
    progress === "cancelled" ? "Stopped" : progress === "failed" && exitCode === null ? "Failed" : exitCode ? `Exit code ${exitCode}` : progress === "done" ? "Success" : null;
  return (
    <div className="group/shell relative mt-1 flex flex-col overflow-hidden rounded-shell border border-fill-active bg-fill *:shrink-0">
      <p className="px-3 py-1 text-label text-shell-foreground">Shell</p>
      <CopyButton
        text={command}
        tooltip="Copy command"
        size="icon-xs"
        className="absolute end-1 top-1 text-muted-foreground opacity-0 group-hover/shell:opacity-100 focus-visible:opacity-100"
      />
      <button
        type="button"
        disabled={whole}
        onClick={() => setWhole(true)}
        className={cx("px-3 pt-2 text-start font-mono text-code whitespace-pre-wrap wrap-anywhere select-text text-foreground", !whole && "line-clamp-2 cursor-pointer")}
      >
        <span className="text-muted-foreground">$ </span>
        {command}
      </button>
      <Output keep={keep} text={output} />
      {ending && (
        <p className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground">
          <span className="ms-auto flex shrink-0 items-center gap-1">
            {ending === "Success" && <Check className="size-icon-sm" />}
            {ending}
          </span>
        </p>
      )}
    </div>
  );
}

/** A command's output, newest line in view; older lines fade out at the top. */
function Output({ keep, text }: { keep: string; text: string }) {
  const [all, setAll] = useKept(`${keep}:all`);
  const lines = useMemo(() => text.split("\n"), [text]);
  const cut = !all && lines.length > TAIL_LINES;
  return (
    <div className="flex max-h-shell-output scroll-edge-fade edge-fade-shell flex-col-reverse overflow-y-auto px-3 py-2">
      <pre className="font-mono text-code font-medium whitespace-pre-wrap wrap-anywhere text-shell-foreground">
        {text ? (cut ? lines.slice(-TAIL_LINES).join("\n") : text) : <span className="text-muted-foreground">No output</span>}
      </pre>
      {cut && (
        <Button size="inline" variant="link" className="self-start pb-1 text-xs" onClick={() => setAll(true)}>
          Show all {lines.length.toLocaleString()} lines
        </Button>
      )}
    </div>
  );
}

/** A code box, titled or not: a tool's input or output, what an approval asked. */
export function ToolBox({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col rounded-control bg-code-surface text-action-hover">
      {title && <p className="px-3 pt-2 text-xs text-muted-foreground">{title}</p>}
      <div className={cx("max-h-60 overflow-auto px-3 pb-2 font-mono text-code whitespace-pre-wrap wrap-anywhere select-text", !title && "pt-2")}>{children}</div>
    </div>
  );
}

/** `what`: its input's title, an MCP tool's own words ("search jira issues") as the old app's. */
function ToolDetail({ name, what, input, output, failed }: { name: string; what: string; input: string; output: string; failed: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 pt-1">
      {failed && <ErrorLine size="sm" error={`${name} failed.`} />}
      {input && <ToolBox title={what}>{input}</ToolBox>}
      {output ? <ToolBox title="Output">{output}</ToolBox> : !failed && <p className="text-sm text-muted-foreground">Tool returned no content</p>}
    </div>
  );
}
