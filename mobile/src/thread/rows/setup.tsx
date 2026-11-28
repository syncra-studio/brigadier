// A worktree's setup under its launch's message, after the desktop's components/thread/setup.tsx.
import { Text, View } from "react-native";
import type { Setup, SetupStep } from "../../../../app/shared/thread";
import { SETUP_TITLES } from "../../../../app/shared/words";
import { Branch, Check, Spinner, X } from "../../../../app/ui/src/icons";
import { Spin } from "../../compose/motion";
import { color } from "../../theme";
import { ErrorLine, Glyph, Line, Opening, s, Words } from "./parts";

const ICONS = { running: Spinner, done: Check, failed: X };

/** The old app's setupStepWords; Rust has already folded the states and ordered the steps. */
function words(step: SetupStep): string {
  const { state } = step;
  switch (step.kind) {
    case "worktree":
      return state === "running" ? `Creating the branch from ${step.base ?? "branch"}` : state === "done" ? `Created ${step.branch ?? "the branch"} from ${step.base ?? "branch"}` : "Couldn't create the worktree";
    case "setupScript":
      return state === "running" ? "Running the setup script" : state === "done" ? "Ran the setup script" : "The setup script failed";
    case "cli":
      return state === "running" ? `Starting ${step.cli ?? "the CLI"}` : state === "done" ? `Started ${step.cli ?? "the CLI"}` : `Couldn't start ${step.cli ?? "the CLI"}`;
  }
}

/** Its steps open while it runs and when it fails, one line once done [D77]. */
export function SetupRow({ keep, setup }: { keep: string; setup: Setup }) {
  // Its worktree step's own state, so a later step starting never turns "Created" back into "Creating" [D85].
  const phase = setup.state === "failed" ? "failed" : (setup.steps.find((step) => step.kind === "worktree")?.state ?? setup.state);
  return (
    <Opening
      key={phase}
      keep={`${keep}:${phase}`}
      initial={phase !== "done"}
      label={SETUP_TITLES[phase]}
      detail={setup.steps.map((step) => {
        const error = step.error || (step.interrupted ? "Interrupted" : step.signal != null ? `Signal ${step.signal}` : step.code != null && step.code !== 0 ? `Exit code ${step.code}` : null);
        const Icon = ICONS[step.state];
        const icon = <Icon className="size-4 shrink-0 text-row-foreground" />;
        return (
          <View key={step.kind}>
            <Line>
              <Glyph>{step.state === "running" ? <Spin>{icon}</Spin> : icon}</Glyph>
              <Text style={[s.row, s.shrink, step.state === "failed" && { color: color.destructive }]}>{words(step)}</Text>
            </Line>
            {error ? <View style={{ paddingLeft: 24 }}><ErrorLine error={error} /></View> : null}
          </View>
        );
      })}
    >
      <Glyph><Branch className="size-4 shrink-0 text-row-foreground" /></Glyph>
      <Words verb={SETUP_TITLES[phase]} live={phase === "running"} />
    </Opening>
  );
}
