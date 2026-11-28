import { useSyncExternalStore } from "react";
import { Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import type { Project, Row } from "../../../app/shared/rows";
import { sentAt } from "../../../app/shared/words";
import { lists, needsYou, shown } from "../mac/mac";
import { color, text } from "../theme";

/** What a row's mark says, in words: Rust decides the mark [D173]. */
const MARK: Record<string, string> = { working: "Working…", needs: "Needs you", amber: "Needs you", unread: "New", background: "Running in the background" };

/** The Mac's sessions: those that need you first, then each project's, newest first, then chats with no project. Each project's pencil starts a new chat there. */
export function Sessions({ onOpen, onSamples, onNew }: { onOpen: (row: Row) => void; onSamples: () => void; onNew: (project: Project) => void }) {
  const { rows, projects, ready } = useSyncExternalStore(lists.subscribe, lists.get);
  const visible = rows.filter(shown).sort((a, b) => b.updated - a.updated);
  const needs = visible.filter(needsYou);
  const rest = visible.filter((row) => !needsYou(row));
  const named = [...projects].sort((a, b) => (b.pinned ?? 0) - (a.pinned ?? 0) || a.name.localeCompare(b.name));
  const sections = [
    { title: "Needs you", data: needs },
    ...named.map((p) => ({ title: p.name, project: p, data: rest.filter((row) => row.project === p.id) })),
    { title: "Chats", data: rest.filter((row) => !row.project || !projects.some((p) => p.id === row.project)) },
  ].filter((s) => s.data.length || ("project" in s && !s.project.removing));
  return (
    <SectionList
      style={styles.page}
      contentInsetAdjustmentBehavior="automatic"
      sections={sections}
      keyExtractor={(row) => row.id}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => (
        <View style={styles.header}>
          <Text style={[styles.section, { flex: 1 }]}>{section.title}</Text>
          {"project" in section && section.project && (
            <Pressable accessibilityRole="button" accessibilityLabel={`New chat in ${section.title}`} onPress={() => onNew(section.project!)} hitSlop={12} style={styles.pencil}>
              <Text style={styles.title}>✎</Text>
            </Pressable>
          )}
        </View>
      )}
      renderItem={({ item }) => <SessionRow row={item} onPress={() => onOpen(item)} />}
      ListEmptyComponent={<Text style={styles.empty}>{ready ? "No sessions on this Mac yet." : "Connecting…"}</Text>}
      ListFooterComponent={
        <Pressable accessibilityRole="link" accessibilityLabel="Samples" onPress={onSamples} style={styles.footer}>
          <Text style={styles.muted}>Samples</Text>
        </Pressable>
      }
    />
  );
}

function SessionRow({ row, onPress }: { row: Row; onPress: () => void }) {
  const mark = row.mark && MARK[row.mark];
  const title = row.title || "New session";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title, mark].filter(Boolean).join(", ")}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: color.muted }]}
    >
      <View style={styles.dotBox}>{row.mark && <View style={[styles.dot, row.mark === "working" ? styles.working : row.mark === "background" ? styles.calm : styles.blue]} />}</View>
      <View style={{ flex: 1 }}>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        <Text style={styles.muted} numberOfLines={1}>
          {[mark, row.updated ? sentAt(row.updated) : null].filter(Boolean).join(" · ")}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.background },
  header: { flexDirection: "row", alignItems: "flex-end" },
  pencil: { paddingHorizontal: 20, paddingBottom: 6 },
  section: { ...text.sm, color: color.mutedForeground, fontWeight: "600", paddingHorizontal: 20, paddingTop: 24, paddingBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 10, gap: 10 },
  dotBox: { width: 10, alignItems: "center" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  blue: { backgroundColor: color.link },
  working: { backgroundColor: color.foreground },
  calm: { backgroundColor: color.mutedForeground },
  title: { ...text.base, color: color.foreground },
  muted: { ...text.sm, color: color.mutedForeground },
  empty: { ...text.base, color: color.mutedForeground, padding: 20 },
  footer: { padding: 20, alignItems: "center" },
});
