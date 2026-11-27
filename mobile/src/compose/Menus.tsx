// The composer's `/`, `@` and + menus, as the desktop's composer/menus.tsx, kind-icons.tsx and tools.tsx: a panel as
// wide as the card just over it, in the rail's place, headed by kind, each row an icon, the name with the letters typed
// in bold, and its line in grey after it.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { request } from "../link";
import { color, size, text } from "../theme";
import { Boxed, Glyph } from "./Glyph";
import { forMac } from "./state";

/** A `/` list row: the agent's command, or Brigadier's own; `run`, one the composer runs itself (/overnight). */
export type Command = { id: string; kind: "command" | "tool" | "skill" | "mcp" | "prompt"; label: string; description?: string; instant: boolean };
/** An `@` row; a `direct` one sends the next message to that worker alone. */
export type Mention = { id: string; type: string; label: string; name?: string; detail?: string; hint?: string };
type MentionGroup = { title: string | null; items: Mention[]; note?: string };

/** Brigadier's own tools, as the desktop's tools.tsx. */
export const TOOLS: Command[] = [
  ["computer", "Use the apps on your Mac"],
  ["browser", "Open pages, click and type in Brigadier's browser"],
  ["mockup", "Draw 3 looks to pick from before building"],
  ["image", "Make or edit a picture"],
  ["research", "Search and read the web, with sources"],
  ["workers", "Split the job across workers in parallel"],
].map(([id, line]): Command => ({ id, kind: "tool", label: `/${id}`, description: line, instant: false }));

const KIND_HEADINGS = { command: "Commands", tool: "Tools", skill: "Skills", mcp: "MCP servers", prompt: "MCP prompts" } as const;
/** A command's colour by kind, for its icon and its chip's name (kind-icons.tsx COMMAND_TONES). */
export const COMMAND_TONES = { command: color.link, tool: color.success, skill: color.magenta, mcp: color.cyan, prompt: color.cyan };
/** A chip's colour in the text: a command's kind's; a note's orange; any other mention blue. */
export const chipTone = (chip: { kind: string; type: string }) => (chip.kind === "command" ? COMMAND_TONES[chip.type as Command["kind"]] : chip.type === "note" ? color.warning : color.link);

/**
 * Where `query` matches `text`, as the menus match: at its start, anywhere in it, or letter by letter in order.
 * The matched letters' positions and how good the match is (0 start, 1 anywhere, 2 in order); null: no match.
 */
export function fuzzyMatch(words: string, query: string): { rank: 0 | 1 | 2; at: number[] } | null {
  const lower = words.toLowerCase();
  const want = query.toLowerCase();
  const run = (from: number) => Array.from(want, (_, index) => from + index);
  if (lower.startsWith(want)) return { rank: 0, at: run(0) };
  const inside = lower.indexOf(want);
  if (inside >= 0) return { rank: 1, at: run(inside) };
  const at: number[] = [];
  let from = 0;
  for (const letter of want) {
    const found = lower.indexOf(letter, from);
    if (found < 0) return null;
    at.push(found);
    from = found + 1;
  }
  return { rank: 2, at };
}

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
  return <>{runs.map((each) => <Text key={each.from} style={each.hit && { fontWeight: "600" }}>{each.words}</Text>)}</>;
}

/** Commands matching `query`, best first within each kind, the kinds in order so no heading repeats. */
function commandMatches(commands: readonly Command[], query: string): Command[] {
  const order = { command: 0, tool: 1, skill: 2, mcp: 3, prompt: 4 };
  const rank = (command: Command) => Math.min(fuzzyMatch(command.label, query)?.rank ?? 3, fuzzyMatch(command.id, query)?.rank ?? 3);
  return commands
    .map((command) => ({ command, rank: rank(command) }))
    .filter(({ rank }) => rank < 3)
    .sort((a, b) => order[a.command.kind] - order[b.command.kind] || a.rank - b.rank)
    .map(({ command }) => command);
}

/** A command's icon: its kind's in its colour (an agent's own SVG mark can't be drawn here). */
const CommandIcon = ({ command }: { command: Command }) => <Boxed mark={command.kind === "skill" ? "✦" : command.kind === "mcp" || command.kind === "prompt" ? "◇" : "/"} color={COMMAND_TONES[command.kind]} />;
/** A mention's icon: a chat, a worker, a tab, a note or a plugin. */
function MentionIcon({ item }: { item: Mention }) {
  const mark = { chat: "❝", worker: "●", direct: "●", tab: "◎", note: "▤", plugin: "◈" }[item.type] ?? "·";
  return <Text allowFontScaling={false} style={{ width: size.iconMd, fontSize: 13, textAlign: "center", color: item.type === "note" ? color.warning : color.mutedForeground }}>{mark}</Text>;
}

/** The panel: opaque in a hairline over the card, as wide as it; it scrolls past 10.5 rows' worth. */
export function Panel({ children }: { children: ReactNode }) {
  return (
    <ScrollView style={st.panel} contentContainerStyle={{ padding: 4 }} keyboardShouldPersistTaps="always">
      {children}
    </ScrollView>
  );
}
export const MenuHeading = ({ children }: { children: string }) => <Text style={st.heading}>{children}</Text>;
export const MenuNote = ({ children }: { children: string }) => <Text style={st.note}>{children}</Text>;

/** One row: icon, name, its line in grey after it, a hint at its end; as tall as a finger needs. */
export function MenuRow({ icon, title, detail, hint, disabled, onPress }: { icon?: ReactNode; title: ReactNode; detail?: string; hint?: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [st.row, pressed && { backgroundColor: color.fill }, disabled && { opacity: size.disabled }]}>
      {icon}
      <Text style={st.title} numberOfLines={1}>
        {title}
        {detail ? <Text style={st.detail}>{`  ${detail}`}</Text> : null}
      </Text>
      {hint ? <Text style={st.detail} numberOfLines={1}>{hint}</Text> : null}
    </Pressable>
  );
}

/** The agent's commands from Rust for the `/` menu, asked again as a turn starts or ends (`fresh`) and as it opens (`opened`); null while not read yet. */
export function useCommands(id: string, fresh: unknown, opened: number) {
  const { run } = forMac();
  const [listed, setListed] = useState<Command[] | null>(null);
  useEffect(() => {
    let live = true;
    void run(["commands", id]).then((reply) => {
      if (!live) return;
      const list: { name: string; description?: string; kind: Command["kind"]; instant: boolean }[] = reply.ok ? (reply.commands ?? []) : [];
      // A prompt kept as Claude listed it before prompts had a kind of their own.
      const kindOf = (each: (typeof list)[number]) => (each.kind === "mcp" && each.name.startsWith("mcp__") ? "prompt" : each.kind);
      setListed(list.map((each) => ({ id: `${kindOf(each)}:${each.name}`, kind: kindOf(each), label: `/${each.name}`, description: each.description || undefined, instant: each.instant })));
    });
    return () => void (live = false);
  }, [id, fresh, opened]);
  return { listed };
}

/** The `/` menu: Brigadier's tools first, then the agent's commands, under their kinds' headings. */
export function Commands({ listed, query, onPick }: { listed: Command[] | null; query: string; onPick: (command: Command) => void }) {
  const shown = listed ? commandMatches([...TOOLS, ...listed], query) : [];
  return (
    <Panel>
      {shown.map((each, at) => (
        <View key={each.id}>
          {at === 0 || shown[at - 1].kind !== each.kind ? <MenuHeading>{KIND_HEADINGS[each.kind]}</MenuHeading> : null}
          <MenuRow icon={<CommandIcon command={each} />} title={<MatchedText words={each.label} query={query} />} detail={each.description} onPress={() => onPick(each)} />
        </View>
      ))}
      {shown.length === 0 ? <MenuNote>{listed ? "No commands" : "Loading…"}</MenuNote> : null}
    </Panel>
  );
}

/** The `@` menu: the Mac's groups for the query, only the last asked shown [D127]; `onDirect`, a Message directly row. */
export function Mentions({ id, query, onPick, onDirect }: { id: string; query: string; onPick: (item: Mention) => void; onDirect?: (worker: string) => void }) {
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
                onPress={() => (item.type === "direct" ? onDirect?.(item.id) : onPick(item))}
              />
            ))}
            {group.note ? <MenuNote>{group.note}</MenuNote> : null}
          </View>
        ),
      )}
      {empty ? <MenuNote>{answered ? "No results" : "Searching…"}</MenuNote> : null}
    </Panel>
  );
}

/** The + menu: "Add" with this phone's Photo Library and Files. */
export function PlusMenu({ onPhotos, onFiles }: { onPhotos: () => void; onFiles: () => void }) {
  return (
    <Panel>
      <MenuHeading>Add</MenuHeading>
      <MenuRow icon={<Glyph name="photo" color={color.mutedForeground} />} title="Photo Library" onPress={onPhotos} />
      <MenuRow icon={<Glyph name="document" color={color.mutedForeground} />} title="Files" onPress={onFiles} />
    </Panel>
  );
}

const st = StyleSheet.create({
  // 4 over the card: the column's gap, less 4.
  panel: { flexGrow: 0, maxHeight: size.controlSm * 10.5, marginBottom: -4, borderRadius: size.radiusMenu, borderWidth: 1, borderColor: color.border, backgroundColor: color.popover },
  heading: { ...text.label, color: color.mutedForeground, paddingHorizontal: 8, paddingTop: 8, paddingBottom: 4 },
  note: { ...text.label, color: color.mutedForeground, paddingHorizontal: 8, minHeight: size.touch, textAlignVertical: "center", paddingVertical: 13 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: size.touch, paddingHorizontal: 8, borderRadius: size.radiusMenu - 4 },
  title: { ...text.sm, color: color.foreground, flex: 1 },
  detail: { ...text.sm, color: color.mutedForeground },
});
