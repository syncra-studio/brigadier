// A sheet over the thread, as the model sheet's: a title, what it shows scrolling under it, Done at the end.
import type { ReactNode } from "react";
import { Modal, ScrollView, StyleSheet, Text } from "react-native";
import { Button } from "../Button";
import { color, text, fontWeight } from "../theme";

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <ScrollView style={st.page} contentContainerStyle={{ padding: 24, gap: 12 }}>
        <Text style={st.title}>{title}</Text>
        {children}
        <Button title="Done" secondary onPress={onClose} />
      </ScrollView>
    </Modal>
  );
}

export const st = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.background },
  title: { ...text.pageTitle, fontWeight: fontWeight.semibold, color: color.foreground, marginBottom: 4 },
  heading: { ...text.sm, color: color.mutedForeground, marginTop: 12 },
  body: { ...text.base, color: color.foreground },
  muted: { ...text.sm, color: color.mutedForeground },
  error: { ...text.sm, color: color.destructive },
  link: { ...text.sm, color: color.link },
  item: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 12, backgroundColor: color.fill, paddingHorizontal: 14, paddingVertical: 12 },
  on: { borderWidth: 1, borderColor: color.foreground },
});
