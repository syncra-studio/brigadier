import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, SectionList, StyleSheet, Text, TextInput, View } from "react-native";
import type { Hit, Project, Row } from "../../../app/shared/rows";
import { sentAt } from "../../../app/shared/words";
import { ComposeEditSquare, MagnifyingGlassSmSearch } from "../../../app/ui/src/icons";
import { ask } from "../link";
import { lists, needsYou, shown } from "../mac/mac";
import { color, radius, text, touch } from "../theme";

/** What a row's mark says, in words: Rust decides the mark [D173]. */
const MARK: Record<string, string> = { working: "Working…", needs: "Needs you", amber: "Needs you", unread: "New", background: "Running in the background" };

/**
 * The Mac's sessions: those that need you first, then each project's, newest first, then chats with no project. Each
 * project's pencil starts a new chat there. A search, as the desktop's ⌘K, lists those whose title has the words, then
 * those whose messages do, Rust's best message under each (`search`).
 */
export function Sessions({ onOpen, onSamples, onNew }: { onOpen: (row: Row) => void; onSamples: () => void; onNew: (project: Project) => void }) {
  const { rows, projects, ready } = useSyncExternalStore(lists.subscribe, lists.get);
  const visible = rows.filter(shown).sort((a, b) => b.updated - a.updated);
  const needs = visible.filter(needsYou);
  const rest = visible.filter((row) => !needsYou(row));
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ q: string; hits: Hit[] }>({ q: "", hits: [] });
  const needle = query.trim();
  useEffect(() => {
    if (!needle) return;
    const asking = setTimeout(() => void ask({ op: "search", q: needle }).then((reply) => reply.ok && setHits({ q: needle, hits: reply.hits })), 200);
    return () => clearTimeout(asking);
  }, [needle]);
  // A search reaches archived sessions too, as the desktop's ⌘K does.
  const searched = rows.filter((row) => !row.noteChat && !row.worker).sort((a, b) => b.updated - a.updated);
  const titled = searched.filter((row) => (row.title || "").toLowerCase().includes(needle.toLowerCase()));
  const snippets = new Map((hits.q === needle ? hits.hits : []).map((hit) => [hit.id, hit.snippet]));
  const found = [...titled, ...searched.filter((row) => snippets.has(row.id) && !titled.includes(row))];
  const named = [...projects].sort((a, b) => (b.pinned ?? 0) - (a.pinned ?? 0) || a.name.localeCompare(b.name));
  const sections = needle ? (found.length ? [{ title: "Sessions", data: found }] : []) : [
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
              <ComposeEditSquare className="size-icon-md text-foreground" />
            </Pressable>
          )}
        </View>
      )}
      ListHeaderComponent={
        <View style={styles.search}>
          <MagnifyingGlassSmSearch className="size-icon-md text-muted-foreground" />
          <TextInput value={query} onChangeText={setQuery} placeholder="Search sessions" placeholderTextColor={color.placeholder} accessibilityLabel="Search sessions" autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" style={styles.searchText} />
        </View>
      }
      renderItem={({ item }) => <SessionRow row={item} line={needle ? snippets.get(item.id) : undefined} onPress={() => onOpen(item)} />}
      ListEmptyComponent={<Text style={styles.empty}>{needle ? `No sessions match “${needle}”` : ready ? "No sessions on this Mac yet." : "Connecting…"}</Text>}
      ListFooterComponent={
        <Pressable accessibilityRole="link" accessibilityLabel="Samples" onPress={onSamples} style={styles.footer}>
          <Text style={styles.muted}>Samples</Text>
        </Pressable>
      }
    />
  );
}

function SessionRow({ row, line, onPress }: { row: Row; line?: string; onPress: () => void }) {
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
          {line ?? [mark, row.updated ? sentAt(row.updated) : null].filter(Boolean).join(" · ")}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.background },
  // The model sheet's search field (compose/Model.tsx), as it is.
  search: { flexDirection: "row", alignItems: "center", gap: 8, height: touch, paddingHorizontal: 12, marginHorizontal: 20, marginTop: 8, borderRadius: radius.control, backgroundColor: color.fill },
  searchText: { ...text.sm, color: color.foreground, flex: 1, padding: 0 },
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
