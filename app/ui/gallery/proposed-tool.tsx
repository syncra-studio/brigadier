// Gallery only, deleted once the owner picks: two lighter ways to open a tool step, in place of the stacked
// "Input" / "Output" cards. Both hang under the step line and use only existing tokens.
import { CopyButton } from "../src/components/copy-button";
import { cx } from "../src/components/cx";
import { OpeningRow, StepIcon, Words } from "../src/components/thread/activity-row";
import { fileName } from "../src/components/thread/file-change";
import { toolObject, VERBS } from "../src/components/thread/tool";
import { Check } from "../src/icons";
import { CodeBlock } from "../src/thread/code";
import type { FileChange, Progress, StepKind } from "../src/thread/item";

export type Step = { id: string; kind: StepKind; name: string; input: string; output: string; failed?: boolean };

/** A: no box. The output hangs under the words on a hairline, like a terminal agent's "└". */
const HANGING = "ms-2 border-s border-divider ps-3.5";
/** B: one quiet filled block, no labels and no edge. */
const BLOCK = "mt-0.5 rounded-shell bg-fill px-3 py-2";

/** The step line already says the read file, the query, the subagent's task: only another tool's arguments show. */
const extra = (step: Step) => (step.kind === "other" && step.input ? step.input : null);

export function ProposedStep({ step, look }: { step: Step; look: "hanging" | "block" }) {
  const object = toolObject(step.kind, step.name, step.input);
  const args = extra(step);
  const prose = step.kind === "agent";
  return (
    <OpeningRow
      keep={`proposed:${look}:${step.id}`}
      detail={
        <div className={cx("flex min-w-0 flex-col gap-1.5", look === "hanging" ? HANGING : BLOCK)}>
          {args && <p className="font-mono text-code whitespace-pre-wrap wrap-anywhere text-row-object">{args}</p>}
          {look === "block" && args && <div className="border-t border-divider" />}
          {step.failed && <p className="text-destructive">{step.name} failed.</p>}
          {step.output ? (
            <div className="max-h-shell-output scroll-edge-fade edge-fade-diff overflow-y-auto">
              <p className={cx("whitespace-pre-wrap wrap-anywhere", prose ? "text-sm text-row-foreground" : "font-mono text-code text-shell-foreground")}>{step.output}</p>
            </div>
          ) : (
            !step.failed && <p className="text-sm text-muted-foreground">No output</p>
          )}
        </div>
      }
    >
      <StepIcon kind={step.kind} />
      <Words verb={VERBS[step.kind][1]} object={step.failed ? `${object} — failed` : object} />
    </OpeningRow>
  );
}

/**
 * The Shell box, in the same two looks: no "Shell" title and no edge. "$ command" first (two lines until
 * clicked), copy on hover, the newest output at the bottom with older lines fading at the top, how it ended.
 */
export function ProposedShell({ id, command, output, progress, exitCode, look }: { id: string; command: string; output: string; progress: Progress; exitCode: number | null; look: "hanging" | "block" }) {
  const running = progress === "running" || progress === "pending";
  const ending = progress === "cancelled" ? "Stopped" : progress === "failed" && exitCode === null ? "Failed" : exitCode ? `Exit code ${exitCode}` : progress === "done" ? "Success" : null;
  return (
    <OpeningRow
      keep={`proposed-shell:${look}:${id}`}
      detail={
        <div className={cx("group/shell relative flex min-w-0 flex-col gap-1.5", look === "hanging" ? HANGING : BLOCK)}>
          <CopyButton
            text={command}
            tooltip="Copy command"
            size="icon-xs"
            className={cx("absolute end-1 text-muted-foreground opacity-0 group-hover/shell:opacity-100 focus-visible:opacity-100", look === "block" ? "top-1" : "top-0")}
          />
          <p className="line-clamp-2 pe-7 font-mono text-code whitespace-pre-wrap wrap-anywhere text-foreground">
            <span className="text-muted-foreground">$ </span>
            {command}
          </p>
          {look === "block" && <div className="border-t border-divider" />}
          <div className="flex max-h-shell-output scroll-edge-fade edge-fade-shell flex-col-reverse overflow-y-auto">
            <pre className="font-mono text-code whitespace-pre-wrap wrap-anywhere text-shell-foreground">
              {output || <span className="text-muted-foreground">No output</span>}
            </pre>
          </div>
          {ending && (
            <p className={cx("flex items-center gap-1 text-xs", ending === "Success" ? "text-muted-foreground" : ending === "Stopped" ? "text-muted-foreground" : "text-destructive")}>
              {ending === "Success" && <Check className="size-icon-sm" />}
              {ending}
            </p>
          )}
        </div>
      }
    >
      <StepIcon kind="run" />
      <Words verb={running ? "Running" : progress === "cancelled" ? "Stopped" : "Ran"} object={command} live={progress === "running"} />
    </OpeningRow>
  );
}

/** The diff card drawn by the thread's own code block: lazy colours, only the shown lines drawn, the same fold. */
export function ProposedDiff({ id, change }: { id: string; change: FileChange }) {
  return (
    <OpeningRow keep={`proposed-diff:${id}`} detail={<CodeBlock code={change.diff} language="diff" keep={`proposed-diff-fold:${id}`} />}>
      <StepIcon kind="edit" />
      <Words verb="Edited" object={fileName(change.path)} />
    </OpeningRow>
  );
}
