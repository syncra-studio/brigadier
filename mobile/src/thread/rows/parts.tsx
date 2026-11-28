// The thread rows' shared pieces, after the desktop's activity-row, line, labeled-divider and error-state.
import { type ComponentType, type ReactNode, useState } from "react";
import { Pressable, StyleSheet, Text, type TextStyle, View } from "react-native";
import type { StepKind } from "../../../../app/shared/thread";
import { ChevronRight, ChevronRightAlt, EditPencil, File, Folder, Globe, Info, type IconProps, MagnifyingGlassSmSearch, RobotHead, Terminal, Tools, ToolsSkills } from "../../../../app/ui/src/icons";
import { color, mono } from "../../theme";

// What the user opened stays open while its row scrolls out of the list and back, as the desktop's useKept.
const kept = new Map<string, boolean>();
export function useKept(key: string, initial = false): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => kept.get(key) ?? initial);
  return [open, (next) => (kept.set(key, next), setOpen(next))];
}

/** "Read" in the row's colour, then its object ("blocks.ts") quieter; a live one brighter, as it moves on the desktop. */
export function Words({ verb, object, live = false }: { verb: string; object?: string | null; live?: boolean }) {
  return (
    <Text style={[s.row, s.shrink, live && { color: color.foreground }]} numberOfLines={2}>
      {verb}
      {object ? <Text style={live ? undefined : s.object}>{` ${object}`}</Text> : null}
    </Text>
  );
}

/** A row's icon before its words, in a 16-wide column. */
export function Glyph({ children }: { children: ReactNode }) {
  return <View style={s.glyph} accessible={false}>{children}</View>;
}

const ICONS: Record<StepKind, ComponentType<IconProps>> = {
  read: File,
  edit: EditPencil,
  list: Folder,
  search: MagnifyingGlassSmSearch,
  run: Terminal,
  web: Globe,
  agent: RobotHead,
  skill: ToolsSkills,
  other: Tools,
};

/** A step's icon, by its kind (or any icon), as the desktop's activity-row StepIcon. */
export function StepIcon({ kind, icon: Icon = ICONS[kind ?? "other"] }: { kind?: StepKind; icon?: ComponentType<IconProps> }) {
  return <Glyph><Icon className="size-4 shrink-0 text-row-foreground" /></Glyph>;
}

/** Turned a quarter while open, as the desktop's chevrons. */
const turned = (open: boolean) => (open ? { transform: [{ rotate: "90deg" }] } : null);

/** One row that doesn't open. */
export function Line({ children }: { children: ReactNode }) {
  return <View style={s.line}>{children}</View>;
}

/** A row that opens and shuts, its chevron after its words. */
export function Toggle({ open, label, onPress, children }: { open: boolean; label: string; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open }} onPress={onPress} hitSlop={6} style={({ pressed }) => [s.line, pressed && { opacity: 0.6 }]}>
      {children}
      <View style={[s.chevron, turned(open)]} accessible={false}><ChevronRightAlt className="size-icon-sm shrink-0 text-faint-foreground" /></View>
    </Pressable>
  );
}

/** A row that opens to its detail under it; `trail` shows while it's shut. */
export function Opening({ keep, label, children, detail, trail, initial }: { keep: string; label: string; children: ReactNode; detail: ReactNode; trail?: ReactNode; initial?: boolean }) {
  const [open, setOpen] = useKept(keep, initial);
  return (
    <View>
      <Toggle open={open} label={label} onPress={() => setOpen(!open)}>
        {children}
        {!open && trail}
      </Toggle>
      {open && <View style={s.detail}>{detail}</View>}
    </View>
  );
}

/** A line across the thread between two hairlines; its ⓘ shows the rest under it, as the desktop's tip does. */
export function Divider({ icon: Icon, children, tip }: { icon?: ComponentType<IconProps>; children: ReactNode; tip?: string | null }) {
  const [shown, setShown] = useState(false);
  return (
    <View>
      <View style={s.divider}>
        <View style={s.hair} />
        <Text style={[s.row, s.center]}>
          {Icon && <><Icon className="size-icon-sm text-row-foreground" />{"  "}</>}
          {children}
        </Text>
        {tip ? (
          <Pressable accessibilityRole="button" accessibilityLabel={tip} accessibilityState={{ expanded: shown }} onPress={() => setShown(!shown)} hitSlop={8}>
            <Info className="size-icon-sm text-row-foreground" />
          </Pressable>
        ) : null}
        <View style={s.hair} />
      </View>
      {shown && tip ? <Text style={[s.small, s.center]}>{tip}</Text> : null}
    </View>
  );
}

/** Something that failed, said calmly: one red line, and Details opening the error's own words. */
export function ErrorState({ summary, details }: { summary: string; details?: string | null }) {
  const [open, setOpen] = useState(false);
  const words = details?.trim() ?? "";
  return (
    <View style={{ gap: 4 }}>
      <View style={s.wrap}>
        <Text style={[s.row, { color: color.destructive }]}>{summary}</Text>
        {words ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Details" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} hitSlop={6} style={s.with}>
            <Text style={s.row}>Details</Text>
            <View style={turned(open)}><ChevronRight className="size-icon-xs text-row-foreground" /></View>
          </Pressable>
        ) : null}
      </View>
      {open && words ? <Text style={[s.code, { color: color.rowObject }]} selectable>{words}</Text> : null}
    </View>
  );
}

/** A red line. */
export const ErrorLine = ({ error }: { error: string | null | undefined }) => (error ? <Text style={[s.row, { color: color.destructive }]}>{error}</Text> : null);

/** What the phone can't draw yet: one quiet row. */
export const OnMac = () => <Text style={[s.row, s.object]}>Shown on your Mac</Text>;

/** Lines shown before "Show all" on a long output. */
const CAP = 12;

/** Long text in at most 12 lines (the newest with `tail`), a tap showing all of it; `paint` colours a line. */
export function Capped({ keep, text, tail = false, paint, style }: { keep: string; text: string; tail?: boolean; paint?: (line: string) => TextStyle | undefined; style?: TextStyle }) {
  const [all, setAll] = useKept(`${keep}:all`);
  const lines = text.split("\n");
  const cut = !all && lines.length > CAP;
  const shown = cut ? (tail ? lines.slice(-CAP) : lines.slice(0, CAP)) : lines;
  const more = cut && (
    <Pressable accessibilityRole="button" accessibilityLabel={`Show all ${lines.length.toLocaleString()} lines`} onPress={() => setAll(true)} hitSlop={6}>
      <Text style={[s.small, { color: color.link }]}>Show all {lines.length.toLocaleString()} lines</Text>
    </Pressable>
  );
  return (
    <View style={{ gap: 4 }}>
      {tail && more}
      <Text style={[s.code, style]} selectable>
        {paint ? shown.map((line, at) => <Text key={at} style={paint(line)}>{at ? `\n${line}` : line}</Text>) : shown.join("\n")}
      </Text>
      {!tail && more}
    </View>
  );
}

/** A code box, titled or not: a tool's input or output, what an approval asked. */
export function Box({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View style={s.box}>
      {title ? <Text style={s.small}>{title}</Text> : null}
      {children}
    </View>
  );
}

export const s = StyleSheet.create({
  row: { fontSize: 14, lineHeight: 21, color: color.rowForeground },
  object: { color: color.rowObject },
  small: { fontSize: 12, lineHeight: 17, color: color.mutedForeground },
  code: { fontFamily: mono, fontSize: 12.5, lineHeight: 18, color: color.foreground },
  shrink: { flexShrink: 1 },
  center: { flexShrink: 1, textAlign: "center" },
  line: { flexDirection: "row", alignItems: "flex-start", gap: 8, minHeight: 21 },
  wrap: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 10 },
  glyph: { width: 16, height: 21, alignItems: "center", justifyContent: "center" },
  chevron: { height: 21, justifyContent: "center" },
  // Details and its chevron.
  with: { flexDirection: "row", alignItems: "center", gap: 4 },
  detail: { gap: 4, paddingTop: 4, paddingBottom: 4 },
  divider: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
  hair: { height: StyleSheet.hairlineWidth, flex: 1, minWidth: 16, backgroundColor: color.border },
  box: { gap: 4, borderRadius: 8, backgroundColor: color.codeSurface, paddingHorizontal: 12, paddingVertical: 8 },
  // An opened group's steps: on a guide line under the row's mark [D95].
  steps: { marginLeft: 8, marginTop: 12, gap: 12, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: color.border, paddingLeft: 15 },
});
