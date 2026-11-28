// The composer's `/`, `@` and + menus, as the desktop's composer/menus.tsx, kind-icons.tsx and tools.tsx: a panel as
// wide as the card just over it, in the rail's place, headed by kind, each row an icon, the name with the letters typed
// in bold, and its line in grey after it.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { request } from "../link";
import { color, fontWeight, mono, opacity, radius, shadow, space, spacing, text, touch } from "../theme";
import { Blur, MenuLabel } from "../sheets/Sheet";
import { FileImage, Paperclip } from "../../../app/ui/src/icons";
import { CommandIcon, MentionIcon } from "./KindIcons";
import { forMac } from "./state";
import { KIND_HEADINGS, MENU_NOTES, NEW_SESSION_WORDS, OVERNIGHT_WORDS, TOOL_LINES } from "../../../app/shared/session/composer";
import { commandMatches, type CommandKind, fuzzyMatch, listedCommand, type Mention, type MentionGroup } from "../../../app/shared/menus";
export { fuzzyMatch };
export type { Mention };

/** A `/` list row: the agent's command, or Brigadier's own; `run`, one the composer runs itself (/overnight). */
export type Command = { id: string; kind: CommandKind; label: string; description?: string; instant: boolean; /** Its own icon from Rust: an SVG mark or an image. */ icon?: string | null };

/** Brigadier's own tools, as the desktop's tools.tsx. */
export const TOOLS: Command[] = TOOL_LINES.map(([id, line]): Command => ({ id, kind: "tool", label: `/${id}`, description: line, instant: false }));

/** The desktop's session/side.tsx NEW_SESSION and sessions/overnight.ts OVERNIGHT. */
export const NEW_SESSION: Command = { id: "new-session", kind: "command", ...NEW_SESSION_WORDS, instant: false };
export const OVERNIGHT: Command = { id: "overnight", kind: "command", ...OVERNIGHT_WORDS, instant: true };

/** A command's colour by kind, for its icon and its chip's name (kind-icons.tsx COMMAND_TONES). */
export const COMMAND_TONES = { command: color.link, tool: color.success, skill: color.ansiMagenta, mcp: color.ansiCyan, prompt: color.ansiCyan };
/** A chip's colour in the text: a command's kind's; a note's orange; any other mention blue. */
export const chipTone = (chip: { kind: string; type: string }) => (chip.kind === "command" ? COMMAND_TONES[chip.type as Command["kind"]] : chip.type === "note" ? color.warning : color.link);

/** A row's name, the letters the query matched in bold. */
export function MatchedText({ words, query }: { words: string; query: string }) {
  const match = query ? fuzzyMatch(words, query) : null;
  if (!match) return <>{words}</>;
  const hit = new Set(match.at);
  const runs: { from: number; words: string; hit: boolean }[] = [];
  Array.from(words).forEach((letter, index) => {
    const last = runs[runs.length - 1];
    if (last && last.hit === hit.has(index)) last.words += letter;
    else runs.push({ from: index, words: letter, hit: hit.has(index) });
  });
  return <>{runs.map((each) => <Text key={each.from} style={each.hit && { fontWeight: fontWeight.semibold }}>{each.words}</Text>)}</>;
}

/** The panel: opaque in a hairline over the card, as wide as it; it scrolls past 10.5 rows' worth. */
export function Panel({ children }: { children: ReactNode }) {
  return (
    <ScrollView style={st.panel} contentContainerStyle={st.gutter} keyboardShouldPersistTaps="always">
      {children}
    </ScrollView>
  );
}
export const MenuHeading = ({ children }: { children: string }) => <Text style={st.heading}>{children}</Text>;
export const MenuNote = ({ children }: { children: string }) => (
  <View style={st.note}>
    <Text style={st.noteText}>{children}</Text>
  </View>
);

/**
 * One row, as the desktop's itemClasses with its MenuRow: icon, name, its line in grey after it, a hint at its end
 * (`mono`: a worker's); as tall as a finger needs.
 */
export function MenuRow({ icon, title, detail, hint, mono: code = false, disabled, onPress }: { icon?: ReactNode; title: ReactNode; detail?: string; hint?: string; mono?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [st.row, pressed && { backgroundColor: color.fill }, disabled && { opacity: opacity.disabled }]}>
      {icon !== undefined ? <View style={st.icon}>{icon}</View> : null}
      <Text style={[st.title, detail ? { flexShrink: 1 } : { flex: 1 }]} numberOfLines={1}>{title}</Text>
      {detail ? <Text style={[st.title, st.detail, { flex: 1 }]} numberOfLines={1}>{detail}</Text> : null}
      {hint ? <Text style={[st.hint, code && { fontFamily: mono }]} numberOfLines={1}>{hint}</Text> : null}
    </Pressable>
  );
}

/**
 * The agent's commands from Rust and this session's chats, for the `/` and + menus, asked again as a turn starts or
 * ends (`fresh`) and as a menu opens (`opened`); null while not read yet.
 */
export function useCommands(id: string, fresh: unknown, opened: number) {
  const { run } = forMac();
  const [listed, setListed] = useState<Command[] | null>(null);
  const [chats, setChats] = useState<Mention[]>([]);
  useEffect(() => {
    let live = true;
    void run(["commands", id]).then((reply) => {
      if (!live) return;
      const list: { name: string; description?: string; kind: Command["kind"]; instant: boolean; icon?: string | null }[] = reply.ok ? (reply.commands ?? []) : [];
      setListed(list.map((each) => ({ ...listedCommand(each), icon: each.icon })));
    });
    try {
      request({ op: "mention", owner: id, q: "" }, (reply) => {
        if (live && reply.ok) setChats(reply.groups.flatMap((group: MentionGroup) => group.items.filter((item) => item.type === "chat")));
      });
    } catch {
      // Not connected: no chats in the + menu.
    }
    return () => void (live = false);
  }, [id, fresh, opened]);
  return { listed, chats };
}

/** The `/` menu: Brigadier's tools first, then the agent's commands and `extra`, under their kinds' headings. */
export function Commands({ listed, extra, query, onPick }: { listed: Command[] | null; extra: Command[]; query: string; onPick: (command: Command) => void }) {
  const shown = listed ? commandMatches([...TOOLS, ...listed, ...extra], query) : [];
  return (
    <Panel>
      {shown.map((each, at) => (
        <View key={each.id}>
          {at === 0 || shown[at - 1].kind !== each.kind ? <MenuHeading>{KIND_HEADINGS[each.kind]}</MenuHeading> : null}
          <MenuRow icon={<CommandIcon command={each} />} title={<MatchedText words={each.label} query={query} />} detail={each.description} onPress={() => onPick(each)} />
        </View>
      ))}
      {shown.length === 0 ? <MenuNote>{listed ? MENU_NOTES.noCommands : MENU_NOTES.loading}</MenuNote> : null}
    </Panel>
  );
}

/** The `@` menu: the Mac's groups for the query, only the last asked shown [D127]; `onDirect`, a Message directly row. */
export function Mentions({ id, query, onPick, onDirect }: { id: string; query: string; onPick: (item: Mention) => void; onDirect?: (worker: Mention) => void }) {
  const [found, setFound] = useState<{ query: string; groups: MentionGroup[] } | null>(null);
  const asked = useRef(query);
  useEffect(() => {
    asked.current = query;
    try {
      request({ op: "mention", owner: id, q: query }, (reply) => {
        if (reply.ok && reply.query === asked.current) setFound({ query: reply.query, groups: reply.groups });
      });
    } catch {
      // Not connected: the menu stays as it was.
    }
  }, [query]);
  const answered = found?.query === query;
  // The Mac takes file and folder results out (a Mac path the phone may not send); Message directly only where it goes.
  const groups = (found?.groups ?? []).map((group) => ({ ...group, items: group.items.filter((item) => item.type !== "file" && item.type !== "folder" && (item.type !== "direct" || onDirect)) }));
  const empty = groups.every((group) => group.items.length === 0 && !group.note);
  return (
    <Panel>
      {groups.map((group, at) =>
        group.items.length === 0 && !group.note ? null : (
          <View key={group.title ?? `results-${at}`}>
            {group.title ? <MenuHeading>{group.title}</MenuHeading> : null}
            {group.items.map((item) => (
              <MenuRow
                key={`${group.title}:${item.id}`}
                icon={<MentionIcon item={item} />}
                title={<MatchedText words={item.name ?? item.label} query={query} />}
                detail={item.detail}
                hint={item.type === "chat" ? "Chat" : item.hint}
                mono={item.type === "worker"}
                onPress={() => (item.type === "direct" ? onDirect?.(item) : onPick(item))}
              />
            ))}
            {group.note ? <MenuNote>{group.note}</MenuNote> : null}
          </View>
        ),
      )}
      {empty ? <MenuNote>{answered ? MENU_NOTES.noResults : MENU_NOTES.searching}</MenuNote> : null}
    </Panel>
  );
}

/** The chats the + lists, as the old app's menu kept them to a few. */
const CHAT_ROWS = 5;

/**
 * The + menu: "Add" with this phone's Photo Library and Files, then the `/` menu's tools, skills, MCP servers and
 * prompts, and up to five chats, each picked in at the end of the text.
 */
export function PlusMenu({ listed, chats, onPhotos, onFiles, onCommand, onChat }: { listed: Command[] | null; chats: readonly Mention[]; onPhotos: () => void; onFiles: () => void; onCommand: (command: Command) => void; onChat: (chat: Mention) => void }) {
  const kind = (wanted: "tool" | "skill" | "mcp" | "prompt") => {
    const of = [...TOOLS, ...(listed ?? [])].filter((command) => command.kind === wanted);
    if (of.length === 0) return null;
    return (
      <View key={wanted}>
        <MenuLabel>{KIND_HEADINGS[wanted]}</MenuLabel>
        {of.map((command) => <MenuRow key={command.id} icon={<CommandIcon command={command} />} title={command.label} detail={command.description} onPress={() => onCommand(command)} />)}
      </View>
    );
  };
  return (
    <ScrollView style={[st.panel, st.menu]} contentContainerStyle={st.gutter} keyboardShouldPersistTaps="always">
      <Blur />
      <MenuLabel>Add</MenuLabel>
      <MenuRow icon={<FileImage className="size-icon-md text-muted-foreground" />} title="Photo Library" onPress={onPhotos} />
      <MenuRow icon={<Paperclip className="size-icon-md text-muted-foreground" />} title="Files" onPress={onFiles} />
      {(["tool", "skill", "mcp", "prompt"] as const).map(kind)}
      {chats.length > 0 ? <MenuLabel>Chats</MenuLabel> : null}
      {chats.slice(0, CHAT_ROWS).map((chat) => <MenuRow key={chat.id} icon={<MentionIcon item={chat} />} title={chat.label} hint="Chat" onPress={() => onChat(chat)} />)}
    </ScrollView>
  );
}

// The desktop's ComposerMenu (max-h-command-list, rounded-menu, a border hairline, bg-popover, p-1), its MenuHeading
// (px-2 pt-2 pb-1) and MenuNote (min-h-menu-item px-2); the + is a DropdownMenuContent (bg-menu over a blur, shadow-overlay).
const st = StyleSheet.create({
  // 4 over the card: the column's gap, less 4.
  panel: { flexGrow: 0, maxHeight: spacing.commandList, marginBottom: -space(1), borderRadius: radius.menu, borderWidth: 1, borderColor: color.border, backgroundColor: color.popover },
  menu: { borderWidth: 0, backgroundColor: color.menu, boxShadow: shadow.overlay },
  gutter: { padding: space(1) },
  heading: { ...text.label, color: color.mutedForeground, paddingHorizontal: space(2), paddingTop: space(2), paddingBottom: space(1) },
  note: { minHeight: spacing.menuItem, justifyContent: "center", paddingHorizontal: space(2) },
  noteText: { ...text.label, color: color.mutedForeground },
  row: { flexDirection: "row", alignItems: "center", gap: space(2), minHeight: touch, paddingHorizontal: space(2), borderRadius: radius.menuItem },
  icon: { width: spacing.iconMd, alignItems: "center", justifyContent: "center" },
  title: { ...text.label, color: color.foreground },
  detail: { color: color.mutedForeground },
  hint: { ...text.xs, color: color.mutedForeground, flexShrink: 0, marginStart: "auto" },
});
