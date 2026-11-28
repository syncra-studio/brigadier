import { Pressable, StyleSheet, Text, View } from "react-native";
import { sentAt } from "../../../app/shared/words";
import type { Mac } from "../../modules/link";
import { Button } from "../Button";
import { page, PROBLEMS } from "../Notice";
import type { Problem } from "../pair/pair";
import { StateDot } from "../StateDot";
import { color, space, text, fontWeight } from "../theme";

/** `seen`: the relay says the Mac is offline, and when it was last there (unix s, 0 if never). */
export type Status = "connecting" | "connected" | Problem | "cancelled" | { seen: number };

const said = (s: Status) =>
  typeof s === "object" ? (s.seen ? `Offline · last online ${sentAt(s.seen * 1000)}` : "Offline")
  : s === "connected" ? "Connected" : s === "connecting" ? "Connecting…" : s === "cancelled" ? "Not connected" : PROBLEMS[s].title;

/** The paired Macs: a dot and its name, how each stands, and Forget this Mac. */
export function Macs({ macs, status, onConnect, onForget, onAdd }: {
  macs: Mac[];
  status: Record<string, Status>;
  onConnect: (mac: Mac) => void;
  onForget: (mac: Mac) => void;
  onAdd: () => void;
}) {
  return (
    <View style={styles.page}>
      <Text style={styles.title}>Your Macs</Text>
      {macs.map((mac) => {
        const s = status[mac.pk] ?? "cancelled";
        return (
          <View key={mac.pk} style={styles.row}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
              <StateDot tone={s === "connected" ? "ready" : "off"} />
              <Text style={styles.name}>{mac.name}</Text>
            </View>
            <Text style={styles.status}>{said(s)}</Text>
            <View style={styles.actions}>
              {s === "connected" && <Action title="Open" onPress={() => onConnect(mac)} />}
              {s !== "connected" && s !== "connecting" && <Action title="Try again" onPress={() => onConnect(mac)} />}
              <Action title="Forget this Mac" onPress={() => onForget(mac)} />
            </View>
          </View>
        );
      })}
      <View style={styles.add}>
        <Button title="Add a Mac" onPress={onAdd} secondary />
      </View>
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
  title: { ...text.pageTitle, fontWeight: fontWeight.semibold, color: color.foreground },
  row: { backgroundColor: color.surfaceUnder, borderColor: color.border, borderWidth: 1, borderRadius: 16, padding: 16, gap: 4 },
  name: { ...text.lg, fontWeight: "600", color: color.foreground },
  status: { ...text.sm, color: color.mutedForeground },
  actions: { flexDirection: "row", gap: 20, marginTop: 8 },
  link: { ...text.sm, fontWeight: "600", color: color.foreground },
  add: { marginTop: "auto" },
});
