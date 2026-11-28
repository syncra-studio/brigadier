import { Branch, Check, Spinner, X } from "../../icons";
import type { Setup } from "../../thread/item";
import { useKept } from "../../thread/kept";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../collapsible";
import { cx } from "../cx";
import { ErrorLine } from "../error-line";
import { Chevron, DETAIL, ROW, TOGGLE, Words } from "./activity-row";
import { SETUP_TITLES as TITLES, setupStepError, setupStepWords as words } from "../../../../shared/words";

const ICONS = { running: Spinner, done: Check, failed: X };

/** Its steps open while it runs and when it fails, one line once done; it sits under its message, so nothing above moves [D77]. */
export function SetupRow({ keep, setup }: { keep: string; setup: Setup }) {
  // Its worktree step's own state, so a later step starting never turns "Created" back into "Creating" nor opens it again [D85].
  const phase = setup.state === "failed" ? "failed" : (setup.steps.find((step) => step.kind === "worktree")?.state ?? setup.state);
  return <Card key={phase} keep={keep} setup={setup} phase={phase} />;
}

function Card({ keep, setup, phase }: { keep: string; setup: Setup; phase: Setup["state"] }) {
  const [open, setOpen] = useKept(`${keep}:${phase}`, phase !== "done");
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex min-w-0 flex-col" data-slot="setup-line" data-state={setup.state}>
      <CollapsibleTrigger className={cx(ROW, TOGGLE)}>
        <Branch className="size-4 shrink-0" />
        <Words verb={TITLES[phase]} live={phase === "running"} />
        <Chevron />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className={DETAIL} data-slot="setup-steps">
          {setup.steps.map((step) => {
            const Icon = ICONS[step.state];
            const error = setupStepError(step);
            return (
              <div key={step.kind} data-step={step.kind} data-state={step.state} className="flex min-w-0 flex-col">
                <span className={ROW}>
                  <Icon className={cx("size-4 shrink-0", step.state === "running" && "animate-spin")} />
                  <span className={cx("min-w-0 truncate", step.state === "failed" && "text-destructive", step.state === "running" && "shimmer")}>{words(step)}</span>
                </span>
                <ErrorLine error={error} size="sm" className="ps-6 break-words" />
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
