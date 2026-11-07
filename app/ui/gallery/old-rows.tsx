// Gallery only, deleted with the "Old app" column: rows the kit has moved on from, as the old app drew them.
import { ROW, StepIcon, Words } from "../src/components/thread/activity-row";
import { ACTIONS } from "../src/components/thread/cards";
import { ToolBox } from "../src/components/thread/tool";
import { Check, X } from "../src/icons";
import type { ApprovalAction, Progress } from "../src/thread/item";

/** The approval: a card once decided. */
export function OldApproval({ title, detail, decision, action = "other" }: { title: string; detail: string; decision: "approved" | "denied" | null; action?: ApprovalAction }) {
  const Icon = ACTIONS[action];
  if (decision === null) {
    return (
      <p className="flex min-h-7 min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <Icon className="size-icon-md shrink-0" />
        <span className="min-w-0 truncate shimmer-quiet">Awaiting approval</span>
      </p>
    );
  }
  return (
    <div className="flex w-full flex-col rounded-thread border border-border bg-card text-foreground">
      <div className="flex min-w-0 items-start gap-2 px-4 pt-3.5 pb-2.5">
        <span className="flex h-5 shrink-0 items-center text-quiet-foreground">
          <Icon className="size-4.5" />
        </span>
        <p className="min-w-0 text-sm leading-5 font-medium wrap-anywhere">{title}</p>
      </div>
      {detail && (
        <div className="flex flex-col gap-2 px-4">
          <ToolBox>{detail}</ToolBox>
        </div>
      )}
      <p className="flex items-center justify-end gap-1 px-4 pt-2.5 pb-3.5 text-xs text-muted-foreground">
        {decision === "approved" ? <Check className="size-icon-sm text-success" /> : <X className="size-icon-sm text-destructive" />}
        {decision === "approved" ? "Allowed" : "Denied"}
      </p>
    </div>
  );
}

/** The subagent: one quiet row, "Running a subagent" shimmering. */
export function OldSubagent({ title, progress }: { title: string; progress: Progress }) {
  const running = progress === "running";
  return (
    <p className={ROW}>
      <StepIcon kind="agent" />
      {progress === "pending" ? (
        <Words verb="Waiting to run a subagent:" object={title} />
      ) : progress === "cancelled" ? (
        <Words verb="Stopped a subagent:" object={title} />
      ) : (
        <Words verb={running ? "Running a subagent" : "Ran a subagent:"} object={running ? undefined : progress === "failed" ? `${title} — failed` : title} live={running} />
      )}
    </p>
  );
}
