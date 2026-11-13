import type { TodoStep } from "../../thread/item";
import { useKept } from "../../thread/kept";
import { Check, Dot, Spinner, Tasks, X } from "../../icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../collapsible";
import { CodeSpans } from "../composer/decision-parts";
import { cx } from "../cx";
import { Chevron, DETAIL, ROW, StepIcon, TOGGLE, Words } from "./activity-row";

/** A step's mark, ProgressLine's: done a green check, at work the spinner while its turn runs, dropped a cross, else a dot. */
function Mark({ status, live }: { status: TodoStep["status"]; live: boolean }) {
  const mark = "size-icon-sm shrink-0";
  if (status === "completed") return <Check className={cx(mark, "text-success")} />;
  if (status === "cancelled") return <X className={cx(mark, "text-muted-foreground")} />;
  if (status === "in_progress" && live) return <Spinner className={cx(mark, "text-muted-foreground motion-safe:animate-spin")} />;
  return <Dot className={cx(mark, "text-muted-foreground")} />;
}

/**
 * The agent's to-do list in its turn [D180]: "To-do list 2 of 5 done", opening to its steps, the one at work shimmering
 * while the turn runs and the finished ones quieter. A list emptied by its agent shows nothing.
 */
export function TodoRow({ keep, steps, live }: { keep: string; steps: readonly TodoStep[]; live: boolean }) {
  const [open, setOpen] = useKept(keep, live);
  if (steps.length === 0) return null;
  const done = steps.filter((step) => step.status === "completed").length;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex min-w-0 flex-col">
      <CollapsibleTrigger className={cx(ROW, TOGGLE)}>
        <StepIcon icon={Tasks} />
        <Words verb="To-do list" object={`${done} of ${steps.length} done`} />
        <Chevron />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className={cx(DETAIL, "ps-5.5")}>
          {steps.map((step, at) => {
            const working = step.status === "in_progress" && live;
            return (
              <li key={at} className={cx(ROW, "w-full", (step.status === "completed" || step.status === "cancelled") && "text-muted-foreground")}>
                <Mark status={step.status} live={live} />
                {/* A code chip's own background hides the shimmer's clipped text, so the step at work shimmers plain. */}
                <span className={cx("min-w-0 truncate", working && "shimmer")}>{working ? step.text.replaceAll("`", "") : <CodeSpans text={step.text} />}</span>
              </li>
            );
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
