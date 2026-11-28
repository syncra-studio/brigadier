// A worktree's setup under its launch's message, after the desktop's components/thread/setup.tsx.
import { Text, View } from "react-native";
import type { Setup } from "../../../../app/shared/thread";
import { SETUP_TITLES, setupStepError, setupStepWords as words } from "../../../../app/shared/words";
import { Branch, Check, Spinner, X } from "../../../../app/ui/src/icons";
import { Spin } from "../../compose/motion";
import { color, space } from "../../theme";
import { ErrorLine, Glyph, Line, Live, Opening, s, Words } from "./parts";

const ICONS = { running: Spinner, done: Check, failed: X };

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
        const error = setupStepError(step);
        const Icon = ICONS[step.state];
        const icon = <Icon className="size-4 shrink-0 text-row-foreground" />;
        return (
          <View key={step.kind}>
            <Line>
              <Glyph>{step.state === "running" ? <Spin>{icon}</Spin> : icon}</Glyph>
              {step.state === "running" ? <Live style={s.shrink}>{words(step)}</Live> : <Text style={[s.row, s.shrink, step.state === "failed" && { color: color.destructive }]} numberOfLines={1}>{words(step)}</Text>}
            </Line>
            {error ? <View style={{ paddingLeft: space(6) }}><ErrorLine error={error} /></View> : null}
          </View>
        );
      })}
    >
      <Glyph><Branch className="size-4 shrink-0 text-row-foreground" /></Glyph>
      <Words verb={SETUP_TITLES[phase]} live={phase === "running"} />
    </Opening>
  );
}
