import { type ReactNode, useMemo, useState } from "react";

import { Check, Stop } from "../../icons";
import type { Progress, StepKind } from "../../thread/item";
import { Button } from "../button";
import { CopyButton } from "../copy-button";
import { cx } from "../cx";
import { OpeningRow, ROW, StepIcon, Words } from "./activity-row";

/** A step's verb while it runs and once done ("Reading", "Read"), by kind. */
const VERBS: Record<StepKind, [string, string]> = {
  read: ["Reading", "Read"],
  edit: ["Editing", "Edited"],
  search: ["Searching for", "Searched for"],
  run: ["Running", "Ran"],
  web: ["Searching the web for", "Searched the web for"],
  agent: ["Running a subagent:", "Ran a subagent:"],
  other: ["Using", "Used"],
};

/** Lines of output drawn until the user asks for all of them: a huge log stays cheap. */
const TAIL_LINES = 400;

/**
 * One tool call: "Ran pnpm test", "Reading blocks.ts" (shimmering while it runs), with its kind's icon.
 * A finished call opens: a command to its Shell box, any other tool to its input and output. A failed
 * tool reads "— failed" (a command's exit code shows in its box); a stopped one "Stopped …".
 */
export function ToolRow({
  kind = "other",
  name,
  input,
  output,
  progress,
  exitCode,
  took,
}: {
  kind?: StepKind;
  name: string;
  input: string;
  output: string;
  progress: Progress;
  exitCode: number | null;
  /** How long it took, once done ("in 41s"), or how long it has run. */
  took?: string;
}) {
  const command = kind === "run";
  const object = kind === "other" ? name : input || name;
  const running = progress === "running" || progress === "pending";
  const [doing, done] = VERBS[kind];
  const words =
    progress === "cancelled" ? (
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
  // A running step opens only when it's a command: its output shows as it comes.
  if (running && !command) return <div className={ROW}>{head}</div>;
  return (
    <OpeningRow
      detail={
        command ? (
          <ShellBox command={object} output={output} progress={progress} exitCode={exitCode} />
        ) : (
          <ToolDetail name={name} input={input} output={output} failed={progress === "failed"} />
        )
      }
    >
      {head}
    </OpeningRow>
  );
}

/** A command's box: "Shell", the command (two lines until clicked), its newest output, how it ended. */
export function ShellBox({ command, output, progress, exitCode }: { command: string; output: string; progress: Progress; exitCode: number | null }) {
  const [whole, setWhole] = useState(false);
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
        className={cx("px-3 pt-2 text-start font-mono text-code whitespace-pre-wrap wrap-anywhere text-foreground", !whole && "line-clamp-2 cursor-pointer")}
      >
        <span className="text-muted-foreground">$ </span>
        {command}
      </button>
      <Output text={output} />
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
function Output({ text }: { text: string }) {
  const [all, setAll] = useState(false);
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
      <div className={cx("max-h-60 overflow-auto px-3 pb-2 font-mono text-code whitespace-pre-wrap wrap-anywhere", !title && "pt-2")}>{children}</div>
    </div>
  );
}

function ToolDetail({ name, input, output, failed }: { name: string; input: string; output: string; failed: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 pt-1">
      {failed && <p className="text-destructive">{name} failed.</p>}
      {input && <ToolBox title="Input">{input}</ToolBox>}
      {output ? <ToolBox title="Output">{output}</ToolBox> : !failed && <p className="text-sm text-muted-foreground">Tool returned no content</p>}
    </div>
  );
}
