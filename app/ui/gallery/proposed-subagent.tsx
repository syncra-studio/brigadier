// Gallery only, deleted once the owner picks: a subagent row that stands out while it runs.
import { cx } from "../src/components/cx";
import { OpeningRow, ROW, StepIcon, Words } from "../src/components/thread/activity-row";
import { Spinner } from "../src/icons";
import type { Progress } from "../src/thread/item";

/** Hangs under the words on a hairline, like a terminal agent's "└". */
const HANGING = "ms-2 border-s border-divider ps-3.5";

/**
 * A subagent you can't miss while it runs, and calm once done. Running: a spinning mark, its task in full white,
 * how long it has run, and its current step hanging under it. Done: the approved row with its time and steps
 * quiet after it, opening to its answer. Fields it needs that items don't carry yet: started/ended, the current
 * step, the step count and the answer.
 */
export function ProposedSubagent({
  id,
  title,
  progress,
  took,
  doing,
  steps,
  answer,
}: {
  id: string;
  title: string;
  progress: Progress;
  /** "41s" while it runs, "1m 2s" once done. */
  took: string;
  /** Its current step's words ("Reading lines.ts"), while it runs. */
  doing?: string;
  steps?: number;
  answer?: string;
}) {
  if (progress === "running") {
    return (
      <div className="flex min-w-0 flex-col">
        <p className={cx(ROW, "text-foreground")}>
          <Spinner className="size-4 shrink-0 motion-safe:animate-spin" />
          <span className="min-w-0 truncate">
            Running a subagent: <span className="font-medium">{title}</span>
          </span>
          <span className="shrink-0 text-muted-foreground tabular-nums">{took}</span>
        </p>
        {doing && (
          <p className={cx(HANGING, "py-0.5")}>
            {/* Keyed by its words: each new step starts the sweep again. */}
            <span key={doing} className="block truncate text-sm leading-5.25 shimmer">
              {doing}
            </span>
          </p>
        )}
      </div>
    );
  }
  const verb = progress === "cancelled" ? "Stopped a subagent:" : "Ran a subagent:";
  const tail = [took, steps !== undefined ? `${steps} steps` : null].filter(Boolean).join(" · ");
  const head = (
    <>
      <StepIcon kind="agent" />
      <Words verb={verb} object={progress === "failed" ? `${title} — failed` : title} />
    </>
  );
  return (
    <OpeningRow
      keep={`proposed-agent:${id}`}
      trail={<span className="tabular-nums text-row-object">{tail}</span>}
      detail={<p className={cx(HANGING, "text-sm whitespace-pre-wrap wrap-anywhere text-row-foreground")}>{answer ?? "No answer"}</p>}
    >
      {head}
    </OpeningRow>
  );
}
