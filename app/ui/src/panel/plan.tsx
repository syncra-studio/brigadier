import { type ReactNode, useId, useState } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { cx } from "../components/cx";
import { CheckCircle, ChevronDown, Dot, Spinner, Tasks, X } from "../icons";
import { Line, ROW } from "./source/rows";
import { PLAN_DONE, PLAN_TITLE, PLAN_ENDED as ENDED, PLAN_FINISHED as FINISHED, planCount, planEnded, planSaid } from "../../../shared/rows";

export type Step = { text: string; status: string };

/** A step's mark by its status, as the CLIs write it: done, under way, given up, or still to do. */
const MARK: Record<string, ReactNode> = {
  completed: <CheckCircle />,
  in_progress: <Spinner className="animate-spin motion-reduce:animate-none" />,
  cancelled: <X />,
};

/** A step whole, however long: its mark on the first line, its words wrapping under themselves. */
function StepRow({ step }: { step: Step }) {
  return (
    <li
      className={cx(
        "relative flex min-w-0 items-start gap-2 rounded-sm px-2 py-1 text-label",
        ENDED.has(step.status) && "text-muted-foreground",
        step.status === "in_progress" && "font-medium",
      )}
    >
      <span aria-hidden className="flex h-4.5 min-w-5 shrink-0 items-center justify-center svg:size-4">{MARK[step.status] ?? <Dot />}</span>
      <span className="min-w-0 flex-1 wrap-anywhere">
        <span className="sr-only">{planSaid(step.status)}</span>
        {step.text}
      </span>
    </li>
  );
}

/** Plans opened by hand, by session: hiding the card unmounts it, and it comes back as it was left. */
const planFolds = new Map<string, { open: boolean; earlier: boolean; shown: number; of?: string }>();

/**
 * The agent's own to-do list as its CLI last wrote it (Claude Code's TodoWrite, OpenCode's todowrite, Codex's
 * update_plan), with the finished steps it has since left out: one line, the step under way (else the next one) and the
 * count, a cancelled step in neither number; it opens to the list, what's ended gathered in one row.
 */
export function Plan({ owner, plan }: { owner: string; plan: readonly Step[] }) {
  const [fold, setFold] = useState(() => planFolds.get(owner) ?? { open: false, earlier: false, shown: FINISHED });
  const { open, earlier } = fold;
  const change = (next: Partial<typeof fold>) => {
    const now = { ...fold, ...next };
    planFolds.set(owner, now);
    setFold(now);
  };
  const past = useId();
  const finished = plan.filter((step) => step.status === "completed");
  // The cancelled first, so the newest ten are the finished ones.
  const ended = [...plan.filter((step) => step.status === "cancelled"), ...finished];
  // What Show more showed is that plan's, known by its oldest finished step: another starts over.
  const of = finished[0]?.text;
  const shown = fold.of === of ? fold.shown : FINISHED;
  const left = plan.filter((step) => !ENDED.has(step.status));
  const done = finished.length;
  const total = plan.filter((step) => step.status !== "cancelled").length;
  const over = left.length === 0;
  const current = left.find((step) => step.status === "in_progress") ?? left[0];
  return (
    <Collapsible open={open} onOpenChange={(next) => change({ open: next })} className="flex min-h-0 flex-col">
      <CollapsibleTrigger className={cx(ROW, "shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-foreground focus-visible:focus-ring")}>
        <span aria-hidden className="flex min-w-5 shrink-0 items-center justify-center svg:size-4">
          {over ? <CheckCircle className="text-success" /> : open ? <Tasks /> : (MARK[current?.status ?? ""] ?? <Dot />)}
        </span>
        <span className="min-w-0 flex-1 truncate">{over ? PLAN_DONE : open ? PLAN_TITLE : current?.text}</span>
        <span className="shrink-0 tabular-nums">{planCount(done, total, left.length, over)}</span>
        <ChevronDown aria-hidden className={cx("size-icon-xs shrink-0 transition motion-reduce:transition-none", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex min-h-0 flex-col data-starting-style:*:shrink-0">
        <div className="-me-2.5 flex max-h-60 min-h-0 flex-col overflow-y-auto pt-1 scroll-gutter">
          {ended.length > 0 && !over && (
            <button type="button" aria-expanded={earlier} aria-controls={past} onClick={() => change({ earlier: !earlier })} className="flex h-7 shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-label text-muted-foreground transition-colors hover:text-foreground focus-visible:focus-ring">
              <span aria-hidden className="flex min-w-5 justify-center svg:size-4"><CheckCircle /></span>
              {planEnded(done, ended.length)}
              <ChevronDown aria-hidden className={cx("size-icon-xs transition motion-reduce:transition-none", !earlier && "-rotate-90")} />
            </button>
          )}
          <div id={past} hidden={!over && !earlier}>
            <ul>{ended.slice(-shown).map((step, at) => <StepRow key={at} step={step} />)}</ul>
            {ended.length > shown && (
              <Line onClick={() => change({ shown: shown + FINISHED, of })} className="text-muted-foreground">Show {ended.length - shown} more</Line>
            )}
          </div>
          <ul>{left.map((step, at) => <StepRow key={at} step={step} />)}</ul>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
