import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Mac } from "../../modules/link";
import { page, PROBLEMS } from "../Notice";
import type { Problem } from "../pair/pair";
import { color, text } from "../theme";

export type Status = "connecting" | "connected" | Problem | "cancelled";

const said = (s: Status) =>
  s === "connected" ? "Connected" : s === "connecting" ? "Connecting…" : s === "cancelled" ? "Not connected" : PROBLEMS[s].title;

/** The paired Macs: "● <name>", how each stands, and Forget this Mac. */
export function Macs({ macs, status, onConnect, onForget }: {
  macs: Mac[];
  status: Record<string, Status>;
  onConnect: (mac: Mac) => void;
  onForget: (mac: Mac) => void;
}) {
  return (
    <View style={styles.page}>
      <Text style={styles.title}>Your Macs</Text>
      {macs.map((mac) => {
        const s = status[mac.pk] ?? "cancelled";
        return (
          <View key={mac.pk} style={styles.row}>
            <Text style={styles.name}>
              <Text style={{ color: s === "connected" ? "#3fb950" : color.mutedForeground }}>● </Text>
              {mac.name}
            </Text>
            <Text style={styles.status}>{said(s)}</Text>
            <View style={styles.actions}>
              {s !== "connected" && s !== "connecting" && <Action title="Try again" onPress={() => onConnect(mac)} />}
              <Action title="Forget this Mac" onPress={() => onForget(mac)} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

function Action({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={8}>
      <Text style={styles.link}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { ...page, gap: 16 },
  title: { ...text.pageTitle, color: color.foreground },
  row: { backgroundColor: color.surfaceUnder, borderColor: color.border, borderWidth: 1, borderRadius: 16, padding: 16, gap: 4 },
  name: { ...text.lg, fontWeight: "600", color: color.foreground },
  status: { ...text.sm, color: color.mutedForeground },
  actions: { flexDirection: "row", gap: 20, marginTop: 8 },
  link: { ...text.sm, fontWeight: "600", color: color.foreground },
});
