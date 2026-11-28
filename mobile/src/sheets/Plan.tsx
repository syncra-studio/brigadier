// The agent's plan, as the desktop's panel/plan.tsx opens it: the count, what's ended gathered in one row (shown
// whole once the plan is done, the newest ten with Show more), then what's left.
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { CheckCircle, ChevronDown, Dot, Spinner, X } from "../../../app/ui/src/icons";
import { Spin } from "../compose/motion";
import { lists } from "../mac/mac";
import { color, fontWeight, space } from "../theme";
import { Line, Sheet, st } from "./Sheet";

type Step = { text: string; status: string };
const ENDED = new Set(["completed", "cancelled"]);
/** The finished steps the opened list shows at a time; past it, Show more. */
const FINISHED = 10;
const MARK: Record<string, (tone: string) => ReactNode> = {
  completed: (tone) => <CheckCircle className="size-4" color={tone} />,
  in_progress: (tone) => <Spin><Spinner className="size-4" color={tone} /></Spin>,
  cancelled: (tone) => <X className="size-4" color={tone} />,
};
const SAID: Record<string, string> = { completed: "Done: ", in_progress: "Under way: ", cancelled: "Cancelled: " };

/** A step whole, however long: its mark on the first line, its words wrapping under themselves. */
function StepRow({ step }: { step: Step }) {
  const tone = ENDED.has(step.status) ? color.mutedForeground : color.foreground;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space(2), paddingHorizontal: space(2), paddingVertical: space(1) }} accessible accessibilityLabel={(SAID[step.status] ?? "To do: ") + step.text}>
      <View style={{ minWidth: space(5), height: space(4.5), alignItems: "center", justifyContent: "center" }}>{(MARK[step.status] ?? ((tone: string) => <Dot className="size-4" color={tone} />))(tone)}</View>
      <Text style={[st.lineText, { flex: 1, color: tone }, step.status === "in_progress" && { fontWeight: fontWeight.medium }]}>{step.text}</Text>
    </View>
  );
}

export function Plan({ id, onClose }: { id: string; onClose: () => void }) {
  const plan = useSyncExternalStore(lists.subscribe, () => lists.get().rows.find((row) => row.id === id)?.plan) ?? [];
  const [earlier, setEarlier] = useState(false);
  const [shown, setShown] = useState(FINISHED);
  const finished = plan.filter((step) => step.status === "completed");
  // The cancelled first, so the newest ten are the finished ones.
  const ended = [...plan.filter((step) => step.status === "cancelled"), ...finished];
  const left = plan.filter((step) => !ENDED.has(step.status));
  const done = finished.length;
  const total = plan.filter((step) => step.status !== "cancelled").length;
  const over = plan.length > 0 && left.length === 0;
  return (
    <Sheet title={over ? "Plan done" : "Plan"} description={plan.length === 0 ? "The agent hasn't made a plan in this session." : done > FINISHED && !over ? `${left.length} left` : `${done}/${total}`} onClose={onClose}>
      {plan.length > 0 && (
        <View>
          {ended.length > 0 && !over && (
            <Line icon={<CheckCircle className="size-4 text-muted-foreground" />} onPress={() => setEarlier(!earlier)}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
                <Text style={[st.lineText, { color: color.mutedForeground }]}>{[done && `${done} done`, ended.length > done && `${ended.length - done} cancelled`].filter(Boolean).join(", ")}</Text>
                <View style={!earlier && { transform: [{ rotate: "-90deg" }] }}>
                  <ChevronDown className="size-icon-xs text-muted-foreground" />
                </View>
              </View>
            </Line>
          )}
          {(over || earlier) && ended.slice(-shown).map((step, at) => <StepRow key={`e${at}`} step={step} />)}
          {(over || earlier) && ended.length > shown && (
            <Line onPress={() => setShown(shown + FINISHED)}>
              <Text style={[st.lineText, { color: color.mutedForeground }]}>Show {ended.length - shown} more</Text>
            </Line>
          )}
          {left.map((step, at) => <StepRow key={at} step={step} />)}
        </View>
      )}
    </Sheet>
  );
}
