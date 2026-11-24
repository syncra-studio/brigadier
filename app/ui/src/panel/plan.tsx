import { type ReactNode, useId, useState } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { cx } from "../components/cx";
import { CheckCircle, ChevronDown, Dot, Spinner, Tasks, X } from "../icons";
import { ROW, ROW_HOVER } from "./source/rows";

export type Step = { text: string; status: string };
const ENDED = new Set(["completed", "cancelled"]);

/** A step's mark by its status, as the CLIs write it: done, under way, given up, or still to do. */
const MARK: Record<string, ReactNode> = {
  completed: <CheckCircle />,
  in_progress: <Spinner className="animate-spin motion-reduce:animate-none" />,
  cancelled: <X />,
};
const SAID: Record<string, string> = { completed: "Done: ", in_progress: "Under way: ", cancelled: "Cancelled: " };

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
        <span className="sr-only">{SAID[step.status] ?? "To do: "}</span>
        {step.text}
      </span>
    </li>
  );
}

/** Plans opened by hand, by session: hiding the card unmounts it, and it comes back as it was left. */
export const planFolds = new Map<string, { open: boolean; earlier: boolean }>();

/**
 * The agent's own to-do list as its CLI last wrote it (Claude Code's TodoWrite, OpenCode's todowrite, Codex's
 * update_plan): one line, the step under way (else the next one) and the count, a cancelled step in neither number; it
 * opens to the list, what's ended gathered in one row.
 */
export function Plan({ owner, plan }: { owner: string; plan: readonly Step[] }) {
  const [fold, setFold] = useState(() => planFolds.get(owner) ?? { open: false, earlier: false });
  const { open, earlier } = fold;
  const change = (next: Partial<typeof fold>) => {
    const now = { ...fold, ...next };
    planFolds.set(owner, now);
    setFold(now);
  };
  const past = useId();
  const ended = plan.filter((step) => ENDED.has(step.status));
  const left = plan.filter((step) => !ENDED.has(step.status));
  const done = plan.filter((step) => step.status === "completed").length;
  const total = plan.filter((step) => step.status !== "cancelled").length;
  const over = left.length === 0;
  const current = left.find((step) => step.status === "in_progress") ?? left[0];
  return (
    <Collapsible open={open} onOpenChange={(next) => change({ open: next })} className="flex min-h-0 flex-col">
      <CollapsibleTrigger className={cx(ROW, ROW_HOVER, "shrink-0 cursor-pointer")}>
        <span aria-hidden className="flex min-w-5 shrink-0 items-center justify-center svg:size-4">
          {over ? <CheckCircle className="text-success" /> : open ? <Tasks /> : (MARK[current?.status ?? ""] ?? <Dot />)}
        </span>
        <span className="min-w-0 flex-1 truncate">{over ? "Plan done" : open ? "Plan" : current?.text}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{done}/{total}</span>
        <ChevronDown aria-hidden className={cx("size-icon-xs shrink-0 text-muted-foreground transition motion-reduce:transition-none", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex min-h-0 flex-col">
        <div className="-me-2.5 flex max-h-60 min-h-0 flex-col overflow-y-auto pt-1 scroll-gutter">
          {ended.length > 0 && !over && (
            <button type="button" aria-expanded={earlier} aria-controls={past} onClick={() => change({ earlier: !earlier })} className="flex h-7 shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-label text-muted-foreground hover:bg-summary-row-hover focus-visible:focus-ring">
              <span aria-hidden className="flex min-w-5 justify-center svg:size-4"><CheckCircle /></span>
              {[done && `${done} done`, ended.length > done && `${ended.length - done} cancelled`].filter(Boolean).join(", ")}
              <ChevronDown aria-hidden className={cx("size-icon-xs transition motion-reduce:transition-none", !earlier && "-rotate-90")} />
            </button>
          )}
          <ul id={past} hidden={!over && !earlier}>{ended.map((step, at) => <StepRow key={at} step={step} />)}</ul>
          <ul>{left.map((step, at) => <StepRow key={at} step={step} />)}</ul>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
