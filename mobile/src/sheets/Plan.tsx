// The agent's plan, as the desktop's panel/plan.tsx lists it: what's left, then what's done or given up.
import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { CheckCircle, Dot, Spinner, X } from "../../../app/ui/src/icons";
import { Spin } from "../compose/motion";
import { lists } from "../mac/mac";
import { color, space } from "../theme";
import { Sheet, st } from "./Sheet";

const MARK: Record<string, (tone: string) => ReactNode> = {
  completed: (tone) => <CheckCircle className="size-4" color={tone} />,
  in_progress: (tone) => <Spin><Spinner className="size-4" color={tone} /></Spin>,
  cancelled: (tone) => <X className="size-4" color={tone} />,
};
const SAID: Record<string, string> = { completed: "Done: ", in_progress: "Under way: ", cancelled: "Cancelled: " };
const ENDED = new Set(["completed", "cancelled"]);

export function Plan({ id, onClose }: { id: string; onClose: () => void }) {
  const plan = useSyncExternalStore(lists.subscribe, () => lists.get().rows.find((row) => row.id === id)?.plan) ?? [];
  const left = plan.filter((step) => !ENDED.has(step.status));
  const done = plan.filter((step) => step.status === "completed").length;
  const total = plan.filter((step) => step.status !== "cancelled").length;
  return (
    <Sheet title={plan.length > 0 && left.length === 0 ? "Plan done" : "Plan"} onClose={onClose}>
      {plan.length === 0 ? <Text style={st.muted}>The agent hasn't made a plan in this session.</Text> : <Text style={st.muted}>{done}/{total}</Text>}
      {[...left, ...plan.filter((step) => ENDED.has(step.status))].map((step, at) => (
        <View key={at} style={{ flexDirection: "row", gap: 10 }} accessible accessibilityLabel={(SAID[step.status] ?? "To do: ") + step.text}>
          <View style={{ minWidth: space(5), height: space(4.5), alignItems: "center", justifyContent: "center" }}>{(MARK[step.status] ?? ((tone: string) => <Dot className="size-4" color={tone} />))(ENDED.has(step.status) ? color.mutedForeground : color.foreground)}</View>
          <Text style={[st.body, { flex: 1 }, ENDED.has(step.status) && { color: st.muted.color }, step.status === "in_progress" && { fontWeight: "600" }]}>{step.text}</Text>
        </View>
      ))}
    </Sheet>
  );
}
