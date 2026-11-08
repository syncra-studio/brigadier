import { Branch, Check, Spinner, X } from "../../icons";
import type { Setup, SetupStep } from "../../thread/item";
import { useKept } from "../../thread/kept";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../collapsible";
import { cx } from "../cx";
import { ErrorLine } from "../error-line";
import { Chevron, DETAIL, ROW, TOGGLE, Words } from "./activity-row";

const TITLES = { running: "Creating a worktree", done: "Created a worktree", failed: "Worktree setup failed" };
const ICONS = { running: Spinner, done: Check, failed: X };

/** The old app's setupStepWords; Rust has already folded the states and ordered the steps. */
function words(step: SetupStep): string {
  const { state } = step;
  switch (step.kind) {
    case "worktree":
      return state === "running" ? `Creating ${step.branch ?? "the branch"} from ${step.base ?? "branch"}` : state === "done" ? `Created ${step.branch ?? "the branch"} from ${step.base ?? "branch"}` : "Couldn't create the worktree";
    case "setupScript":
      return state === "running" ? "Running the setup script" : state === "done" ? "Ran the setup script" : "The setup script failed";
    case "cli":
      return state === "running" ? `Starting ${step.cli ?? "the CLI"}` : state === "done" ? `Started ${step.cli ?? "the CLI"}` : `Couldn't start ${step.cli ?? "the CLI"}`;
  }
}

/** Open while starting; remounted by the thread on completion to fold to one action line. */
export function SetupRow({ keep, setup }: { keep: string; setup: Setup }) {
  const starting = setup.state === "running";
  const [open, setOpen] = useKept(`${keep}:${starting ? "starting" : "done"}`, starting);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex min-w-0 flex-col" data-slot="setup-line" data-state={setup.state}>
      <CollapsibleTrigger className={cx(ROW, TOGGLE)}>
        <Branch className="size-4 shrink-0" />
        <Words verb={TITLES[setup.state]} live={starting} />
        <Chevron />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className={DETAIL} data-slot="setup-steps">
          {setup.steps.map((step) => {
            const Icon = ICONS[step.state];
            const error = step.error || (step.interrupted ? "Interrupted" : step.signal != null ? `Signal ${step.signal}` : step.code != null && step.code !== 0 ? `Exit code ${step.code}` : null);
            return (
              <div key={step.kind} data-step={step.kind} data-state={step.state} className="flex min-w-0 flex-col">
                <span className={ROW}>
                  <Icon className={cx("size-4 shrink-0", step.state === "running" && "animate-spin")} />
                  <span className={cx("min-w-0 truncate", step.state === "failed" && "text-destructive")}>{words(step)}</span>
                </span>
                <ErrorLine error={error} size="sm" className="ps-5.5 break-words" />
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
