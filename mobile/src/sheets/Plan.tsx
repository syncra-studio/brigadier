// The agent's plan, as the desktop's panel/plan.tsx lists it: what's left, then what's done or given up.
import { useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { lists } from "../mac/mac";
import { Sheet, st } from "./Sheet";

const MARK: Record<string, string> = { completed: "✓", in_progress: "…", cancelled: "✕" };
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
          <Text style={[st.body, { width: 18, textAlign: "center" }]}>{MARK[step.status] ?? "·"}</Text>
          <Text style={[st.body, { flex: 1 }, ENDED.has(step.status) && { color: st.muted.color }, step.status === "in_progress" && { fontWeight: "600" }]}>{step.text}</Text>
        </View>
      ))}
    </Sheet>
  );
}
