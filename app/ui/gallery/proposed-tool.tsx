// Gallery only, deleted once the owner picks: two lighter ways to open a tool step, in place of the stacked
// "Input" / "Output" cards. Both hang under the step line and use only existing tokens.
import { OpeningRow, StepIcon, Words } from "../src/components/thread/activity-row";
import { toolObject, VERBS } from "../src/components/thread/tool";
import { cx } from "../src/components/cx";
import type { StepKind } from "../src/thread/item";

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
