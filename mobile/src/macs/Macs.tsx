// The paired Macs as the desktop's Settings › Connections lists its devices (settings/connections.tsx,
// connections-device.tsx, parts.tsx SettingsPage, components/settings-card.tsx): the page's title with Add at its end,
// then one card, a row each, hairlines between.
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { pausedLine } from "../../../app/shared/away";
import { CONNECTION_WORDS, sentAt } from "../../../app/shared/words";
import type { Mac } from "../../modules/link";
import { DialogButton } from "../Button";
import { PROBLEMS } from "../Notice";
import type { Problem } from "../pair/pair";
import { color, fontWeight, radius, space, text } from "../theme";

/**
 * `seen`: the relay says the Mac is offline, and when it was last there (unix s, 0 if never). `paused`: the relay
 * carries none of its streams until then (0: no date).
 */
export type Status = "connecting" | "connected" | Problem | "cancelled" | { seen: number } | { paused: number };

const said = (s: Status, name: string) =>
  typeof s === "object" ? ("paused" in s ? pausedLine(s.paused, name) : s.seen ? `Offline · last online ${sentAt(s.seen * 1000)}` : "Offline")
  : s === "connected" ? CONNECTION_WORDS.ready : s === "connecting" ? CONNECTION_WORDS.connecting : s === "cancelled" ? "Not connected" : PROBLEMS[s].title;

/** The paired Macs: each one's name, how it stands, Open or Try again, and Forget this Mac, as a device's row and its Revoke access. */
export function Macs({ macs, status, onConnect, onForget, onAdd }: {
  macs: Mac[];
  status: Record<string, Status>;
  onConnect: (mac: Mac) => void;
  onForget: (mac: Mac) => void;
  onAdd: () => void;
}) {
  return (
    <ScrollView style={st.page} contentContainerStyle={st.column} contentInsetAdjustmentBehavior="automatic">
      <View style={st.header}>
        <Text accessibilityRole="header" style={st.title}>Your Macs</Text>
        <DialogButton title={CONNECTION_WORDS.add} size="sm" onPress={onAdd} />
      </View>
      <View style={st.card}>
        {macs.map((mac, index) => {
          const s = status[mac.pk] ?? "cancelled";
          return (
            <View key={mac.pk} style={st.row}>
              <View style={st.rowText}>
                <Text style={st.rowTitle}>{mac.name}</Text>
                {/* Paused: the desktop's Away from home notice, its row's description in warning. */}
                <Text style={[st.rowLine, typeof s === "object" && "paused" in s && st.warning]}>{said(s, mac.name)}</Text>
              </View>
              {s === "connected" && <DialogButton title="Open" variant="soft" size="sm" onPress={() => onConnect(mac)} />}
              {s !== "connected" && s !== "connecting" && <DialogButton title="Try again" variant="soft" size="sm" onPress={() => onConnect(mac)} />}
              <DialogButton title="Forget this Mac" variant="soft" size="sm" onPress={() => onForget(mac)} />
              {index < macs.length - 1 && <View pointerEvents="none" style={st.hair} />}
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  // SettingsPage: px-5, its header py-3 gap-4, its title text-page-title medium, its sections pt-5 below; pb-12.
  page: { flex: 1, backgroundColor: color.background },
  column: { paddingHorizontal: space(5), paddingBottom: space(12), gap: space(5) },
  header: { flexDirection: "row", alignItems: "flex-start", gap: space(4), paddingVertical: space(3) },
  title: { ...text.pageTitle, fontWeight: fontWeight.medium, color: color.foreground, flex: 1 },
  // SettingsCard: rounded-settings, border-divider, bg-card; its rows' hairlines 16 in.
  card: { borderRadius: radius.settings, borderWidth: 1, borderColor: color.divider, backgroundColor: color.card, overflow: "hidden" },
  hair: { position: "absolute", start: space(4), end: space(4), bottom: 0, height: 1, backgroundColor: color.divider },
  // DeviceRow: items-center gap-3 px-4 py-3; RowText: text-label medium over text-xs quiet, 4 apart.
  // Wraps its buttons under the words when a large text size leaves no room beside them.
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space(3), paddingHorizontal: space(4), paddingVertical: space(3) },
  rowText: { flexGrow: 1, flexShrink: 1, flexBasis: "40%", gap: space(1) },
  rowTitle: { ...text.label, fontWeight: fontWeight.medium, color: color.foreground },
  rowLine: { ...text.xs, color: color.quietForeground },
  warning: { color: color.warning },
});
