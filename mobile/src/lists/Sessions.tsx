// The Mac's sessions as the desktop's sidebar lists them by projects (sidebar/sidebar.tsx, project-row.tsx, row.tsx,
// components/nav.tsx): Pinned projects, Projects by name, each folding its chats under it, then Chats, the sessions in
// no project; rows by the user's last send, newest first, each with its one trailing mark [D30 D31 D63 D173].
import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, Pressable, SectionList, StyleSheet, Text, TextInput, View } from "react-native";
import { attentionOf, hueOf, type Hit, type Project, projectInitials, type Row, statusWords } from "../../../app/shared/rows";
import { deleteAsk, deleteFailed, laidOver } from "../../../app/shared/session/actions";
import { store } from "../../../app/shared/store";
import { CONNECTION_WORDS, newSessionIn, SIDEBAR_WORDS } from "../../../app/shared/words";
import { Chat, ChevronDown, ComposeEditSquare, MagnifyingGlassSearch, SidebarSpinner } from "../../../app/ui/src/icons";
import { Confirm } from "../act/Confirm";
import { Spin } from "../compose/motion";
import { ask, macNow } from "../link";
import { lists, shown } from "../mac/mac";
import { color, fontWeight, radius, space, spacing, text, touch } from "../theme";
import { actionsOf, deleting, rowMenu } from "./actions";

/** No Mac's queue: nothing pending, nothing to catch. */
const IDLE = { queues: store(new Map()), caught: () => {} };

// The tiles' hues in theme.css's order, which is the desktop's TAGS (sidebar/row.tsx) [D283].
const TILES = Object.keys(color).filter((name) => name.startsWith("tile") && name !== "tileInk").map((name) => color[name]!);

/**
 * A project's badge, the desktop's ProjectBadge: an emoji picked in its settings, else its initials on its tile's hue,
 * picked or from its name; no project, the chat bubble its tab shows [D62 D214].
 * shortcut: no logo or picked image, which the desktop reads from the Mac's `/project-icon/`; initials stand in.
 */
export function ProjectBadge({ project }: { project: Pick<Project, "name" | "icon"> | undefined }) {
  if (!project) return <Chat className="size-icon-md" />;
  const at = project.icon?.indexOf(":") ?? -1;
  const [kind, value] = project.icon && at > 0 ? [project.icon.slice(0, at), project.icon.slice(at + 1)] : [];
  if (kind === "emoji") return <View style={[st.badge, { backgroundColor: color.fill }]}><Text style={{ ...text.base, lineHeight: spacing.iconMd }}>{value}</Text></View>;
  const hue = TILES[kind === "tag" ? Number(value) : hueOf(project.name, TILES.length)] ?? TILES[0];
  return (
    <View style={[st.badge, { backgroundColor: hue }]}>
      <Text style={{ ...text.badge, color: color.tileInk }}>{projectInitials(project.name)}</Text>
    </View>
  );
}

/** A row's one trailing mark, the desktop's SidebarMark: a spinner while it runs, a small blue dot when it has news or needs you. */
function SidebarMark({ mark, label }: { mark: Row["mark"]; label: string }) {
  if (mark === "working")
    return (
      <View accessible accessibilityRole="progressbar" accessibilityLabel={label} style={st.slot}>
        <Spin><SidebarSpinner className="size-icon-sm text-foreground" /></Spin>
      </View>
    );
  if (mark === "needs" || mark === "amber" || mark === "unread")
    return (
      <View style={st.slot}>
        <View accessible accessibilityRole="image" accessibilityLabel={label} style={st.dot} />
      </View>
    );
  return null;
}

type Line = { kind: "project"; project: Project; open: boolean; dot: boolean } | { kind: "row"; row: Row; indent: boolean; snippet?: string } | { kind: "empty"; words: string; indent: boolean; of: string };
type Section = { key: string; title: string; open: boolean; data: Line[] };

const byLastSend = (a: Row, b: Row) => b.sent - a.sent || b.id.localeCompare(a.id);

/**
 * The Mac's sessions, as the desktop's sidebar by projects. A tap on a section's title or a project folds it; each
 * project's pencil starts a new session there. A held row offers its own actions (`actions.ts`), each shown at once
 * till Rust's row has it. A search, as the desktop's ⌘K, lists those whose title has the words, then
 * those whose messages do, Rust's best message under each (`search`).
 */
export function Sessions({ onOpen, onSamples, onNew }: { onOpen: (row: Row) => void; onSamples: () => void; onNew: (project: Project) => void }) {
  const { rows: rust, projects, ready, mac } = useSyncExternalStore(lists.subscribe, lists.get);
  // Rows from a Mac no longer connected (shown till the new one's snapshot comes) are inert.
  const stale = mac !== macNow();
  const actions = (stale ? null : actionsOf()) ?? IDLE;
  const pending = useSyncExternalStore(actions.queues.subscribe, actions.queues.get);
  useEffect(() => actions.caught(rust), [rust, actions]);
  const rows = laidOver(rust, pending)!;
  const asked = useSyncExternalStore(deleting.subscribe, deleting.get);
  const words = asked && deleteAsk([asked.row], asked.running);
  // What's folded, by the desktop's keys: "pinned", "projects", "none" and `project:<id>`.
  const [folded, setFolded] = useState<string[]>([]);
  const isOpen = (key: string) => !folded.includes(key);
  const toggle = (key: string) => setFolded(isOpen(key) ? [...folded, key] : folded.filter((each) => each !== key));
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ q: string; hits: Hit[] }>({ q: "", hits: [] });
  const needle = query.trim();
  useEffect(() => {
    if (!needle) return;
    const asking = setTimeout(() => void ask({ op: "search", q: needle }).then((reply) => reply.ok && setHits({ q: needle, hits: reply.hits })), 200);
    return () => clearTimeout(asking);
  }, [needle]);

  const live = rows.filter(shown).sort(byLastSend);
  const chatsIn = (id: string) => live.filter((row) => row.project === id);
  const homeless = live.filter((row) => !row.project || !projects.some((p) => p.id === row.project));
  const byName = [...projects].filter((p) => !p.removing || chatsIn(p.id).length > 0).sort((a, b) => a.name.localeCompare(b.name));
  const projectLines = (list: Project[]) =>
    list.flatMap((project): Line[] => {
      const key = `project:${project.id}`;
      const chats = chatsIn(project.id);
      const head: Line = { kind: "project", project, open: isOpen(key), dot: !isOpen(key) && attentionOf(chats, null) };
      if (!isOpen(key)) return [head];
      return [head, ...(chats.length ? chats.map((row): Line => ({ kind: "row", row, indent: true })) : [{ kind: "empty", words: SIDEBAR_WORDS.noChats, indent: true, of: project.id } as const])];
    });
  const section = (key: string, title: string, data: Line[]): Section => ({ key, title, open: isOpen(key), data: isOpen(key) ? data : [] });
  const pinned = byName.filter((p) => p.pinned).sort((a, b) => b.pinned! - a.pinned!);
  const unpinned = byName.filter((p) => !p.pinned);

  // A search reaches archived sessions too, as the desktop's ⌘K does.
  const searched = rows.filter((row) => !row.noteChat && !row.worker).sort(byLastSend);
  const titled = searched.filter((row) => (row.title || "").toLowerCase().includes(needle.toLowerCase()));
  const snippets = new Map((hits.q === needle ? hits.hits : []).map((hit) => [hit.id, hit.snippet]));
  const found = [...titled, ...searched.filter((row) => snippets.has(row.id) && !titled.includes(row))];

  const sections: Section[] = needle
    ? found.length ? [{ key: "found", title: "Sessions", open: true, data: found.map((row): Line => ({ kind: "row", row, indent: false, snippet: snippets.get(row.id) })) }] : []
    : !ready && !rows.length
      ? []
      : [
          ...(pinned.length ? [section("pinned", SIDEBAR_WORDS.pinned, projectLines(pinned))] : []),
          ...(unpinned.length ? [section("projects", SIDEBAR_WORDS.projects, projectLines(unpinned))] : []),
          section("none", SIDEBAR_WORDS.chats, homeless.length ? homeless.map((row): Line => ({ kind: "row", row, indent: false })) : [{ kind: "empty", words: SIDEBAR_WORDS.noChatsYet, indent: false, of: "none" }]),
        ];
  return (
    <>
    <SectionList
      style={st.page}
      contentContainerStyle={st.list}
      contentInsetAdjustmentBehavior="automatic"
      sections={sections}
      keyExtractor={(line) => (line.kind === "project" ? `p:${line.project.id}` : line.kind === "row" ? line.row.id : `e:${line.of}`)}
      stickySectionHeadersEnabled={false}
      ItemSeparatorComponent={Hair}
      renderSectionHeader={({ section: { key, title, open } }) => (
        <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }} disabled={key === "found"} onPress={() => toggle(key)} style={st.head}>
          <Text style={st.sectionTitle} numberOfLines={1}>{title}</Text>
          {/* Open, the desktop shows its chevron on hover only. */}
          {!open && <View style={{ transform: [{ rotate: "-90deg" }] }}><ChevronDown className="size-icon-sm text-faint-foreground" /></View>}
        </Pressable>
      )}
      ListHeaderComponent={
        <View style={st.searchBox}>
          <View style={st.search}>
            <MagnifyingGlassSearch className="size-icon-md text-quiet-foreground" />
            <TextInput value={query} onChangeText={setQuery} placeholder="Search sessions" placeholderTextColor={color.faintForeground} accessibilityLabel="Search sessions" autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" style={st.searchText} />
          </View>
        </View>
      }
      renderItem={({ item }) =>
        item.kind === "project" ? (
          <ProjectRow project={item.project} open={item.open} dot={item.dot} onToggle={() => toggle(`project:${item.project.id}`)} onNew={() => onNew(item.project)} />
        ) : item.kind === "row" ? (
          <SessionRow row={item.row} indent={item.indent} snippet={item.snippet} onPress={stale ? undefined : () => onOpen(item.row)} onLongPress={stale ? undefined : () => rowMenu(item.row, mac)} />
        ) : (
          <Text style={[st.empty, item.indent && st.indent, !item.indent && { color: color.quietForeground }]}>{item.words}</Text>
        )
      }
      ListEmptyComponent={<Text style={st.empty}>{needle ? `No sessions match “${needle}”` : CONNECTION_WORDS.connecting}</Text>}
      ListFooterComponent={
        <Pressable accessibilityRole="link" accessibilityLabel="Samples" onPress={onSamples} style={st.footer}>
          <Text style={st.faint}>Samples</Text>
        </Pressable>
      }
    />
    {asked && words && asked.mac === macNow() && (
      <Confirm
        mac={asked.mac}
        title={words.title}
        body={words.description}
        shown={asked.row.folder ?? asked.row.title ?? SIDEBAR_WORDS.untitled}
        args={["delete", asked.row.id, "--branch", "keep"]}
        onDone={(reply) => {
          deleting.set(null);
          if (reply && !reply.ok) Alert.alert(deleteFailed(asked.row, reply));
        }}
      />
    )}
    </>
  );
}

// Rows a hair apart, as the desktop's NavList.
const Hair = () => <View style={{ height: 1 }} />;

/** A project's row, the desktop's ProjectRow: its badge, its name, a dot while folded over a session that needs you, and its New session. */
function ProjectRow({ project, open, dot, onToggle, onNew }: { project: Project; open: boolean; dot: boolean; onToggle: () => void; onNew: () => void }) {
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityLabel={project.name} accessibilityState={{ expanded: open }} onPress={onToggle} style={({ pressed }) => [st.row, st.indent, st.projectRow, pressed && st.pressed]}>
        <Text style={st.title} numberOfLines={1}>{project.name}</Text>
        {dot && <SidebarMark mark="unread" label={SIDEBAR_WORDS.attention} />}
      </Pressable>
      {/* On the desktop it shows on hover; a phone has none, so it stays: beside the fold, so VoiceOver reaches it. */}
      <View style={st.projectAction}>
        <Pressable accessibilityRole="button" accessibilityLabel={newSessionIn(project.name)} onPress={onNew} hitSlop={(touch - space(5)) / 2} style={({ pressed }) => [st.action, pressed && st.pressed]}>
          <ComposeEditSquare className="size-icon-sm text-muted-foreground" />
        </Pressable>
      </View>
      <View pointerEvents="none" style={st.badgeAt}>
        <ProjectBadge project={project} />
      </View>
    </View>
  );
}

/** A session on one line, the desktop's SessionRowItem: its title and its mark; under its project, at the name's x. A search's hit has its message under the title. */
function SessionRow({ row, indent, snippet, onPress, onLongPress }: { row: Row; indent: boolean; snippet?: string; onPress?: () => void; onLongPress?: () => void }) {
  const title = row.title || SIDEBAR_WORDS.untitled;
  const words = statusWords(row);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={[title, words].filter(Boolean).join(", ")} accessibilityHint={onLongPress && "Hold for its actions"} accessibilityActions={onLongPress && [{ name: "longpress", label: "Actions" }]} onAccessibilityAction={onLongPress} onPress={onPress} onLongPress={onLongPress} style={({ pressed }) => [st.row, indent && st.indent, pressed && st.pressed]}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[st.chatTitle, row.archived ? { color: color.markerForeground } : null]} numberOfLines={1}>{title}</Text>
        {snippet ? <Text style={st.snippet} numberOfLines={1}>{snippet}</Text> : null}
      </View>
      <View style={{ marginRight: space(0.5) }}>
        <SidebarMark mark={row.mark} label={words ?? ""} />
      </View>
    </Pressable>
  );
}

const st = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.background },
  list: { paddingHorizontal: space(2), paddingBottom: space(2) },
  // The desktop's sidebar search field (pull-requests/nav.tsx, settings/shell.tsx).
  searchBox: { paddingTop: space(2) },
  search: { flexDirection: "row", alignItems: "center", gap: space(2), height: spacing.navSearch, paddingHorizontal: space(3), borderRadius: radius.capsule, borderWidth: 1, borderColor: color.fillActive, backgroundColor: color.fill },
  searchText: { ...text.sm, color: color.foreground, flex: 1, padding: 0 },
  // NavSection's title row, a section's gap (gap-4) over it.
  head: { flexDirection: "row", alignItems: "center", gap: space(1), height: spacing.sectionTitle, marginTop: space(4), marginBottom: space(1), paddingLeft: space(2), paddingRight: space(1.5) },
  sectionTitle: { ...text.sm, fontWeight: fontWeight.medium, color: color.faintForeground, flexShrink: 1 },
  // NavRow: r10, ps-2 pe-1.5, gap-2; as tall as a finger needs, where the desktop's is 30.
  row: { flexDirection: "row", alignItems: "center", gap: space(2), minHeight: touch, borderRadius: radius.row, paddingLeft: space(2), paddingRight: space(1.5) },
  indent: { paddingLeft: space(8) },
  // The project row leaves its New session room at its end; the button sits over it, a sibling.
  projectRow: { paddingRight: space(1.5) + space(5.25) + space(2) },
  projectAction: { position: "absolute", top: 0, bottom: 0, right: space(1.5), justifyContent: "center" },
  pressed: { backgroundColor: color.fill },
  title: { ...text.sm, color: color.foreground, flex: 1 },
  chatTitle: { ...text.sm, color: color.foreground },
  snippet: { ...text.xs, color: color.mutedForeground },
  slot: { width: space(5.25), height: space(5), alignItems: "center", justifyContent: "center" },
  dot: { width: space(1.5), height: space(1.5), borderRadius: radius.capsule, backgroundColor: color.link },
  // RowAction: 21×20, its 14 glyph.
  action: { width: space(5.25), height: space(5), borderRadius: radius.xs, alignItems: "center", justifyContent: "center" },
  badge: { width: spacing.iconMd, height: spacing.iconMd, borderRadius: radius.badge, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  // Over the room the row leaves it, 5 in, as RowAction's 22 square there.
  badgeAt: { position: "absolute", top: 0, bottom: 0, left: space(1.25), width: space(5.5), alignItems: "center", justifyContent: "center" },
  empty: { ...text.sm, color: color.faintForeground, minHeight: spacing.navRow, paddingHorizontal: space(2), lineHeight: spacing.navRow },
  footer: { padding: space(5), alignItems: "center" },
  faint: { ...text.sm, color: color.faintForeground },
});
