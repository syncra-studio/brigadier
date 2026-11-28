// The thread rows' shared pieces, after the desktop's activity-row, line, labeled-divider, tip, error-line and error-state.
import { type ComponentType, type ReactNode, useState } from "react";
import { Pressable, StyleSheet, Text, type TextStyle, View } from "react-native";
import type { StepKind } from "../../../../app/shared/thread";
import { ChevronRight, ChevronRightAlt, EditPencil, File, Folder, Globe, Info, type IconProps, MagnifyingGlassSmSearch, RobotHead, Terminal, Tools, ToolsSkills } from "../../../../app/ui/src/icons";
import { Shimmer } from "../../compose/motion";
import { color, mono, radius, space, text } from "../../theme";

// What the user opened stays open while its row scrolls out of the list and back, as the desktop's useKept.
const kept = new Map<string, boolean>();
export function useKept(key: string, initial = false): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => kept.get(key) ?? initial);
  return [open, (next) => (kept.set(key, next), setOpen(next))];
}

/** Live words, as the desktop's `shimmer`: the live text's colour, pulsing. */
export const Live = ({ children, style }: { children: string; style?: TextStyle }) => <Shimmer style={[s.row, style, { color: color.liveText }]}>{children}</Shimmer>;

/** "Read" in the row's colour, then its object ("blocks.ts") quieter; one line, cut at the column's edge; a live one shimmers. */
export function Words({ verb, object, live = false }: { verb: string; object?: string | null; live?: boolean }) {
  if (live) return <Live style={s.shrink}>{object ? `${verb} ${object}` : verb}</Live>;
  return (
    <Text style={[s.row, s.shrink]} numberOfLines={1}>
      {verb}
      {object ? <Text style={s.object}>{` ${object}`}</Text> : null}
    </Text>
  );
}

/** A row's icon before its words, in a 16-wide box a line high. */
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

/** One row that doesn't open: the desktop's ROW. */
export function Line({ children }: { children: ReactNode }) {
  return <View style={s.line}>{children}</View>;
}

/** The desktop's Chevron, in the row's colour; always shown here, the phone having no hover to show it on. */
export const Chevron = ({ open, faint = false }: { open: boolean; faint?: boolean }) => (
  <View style={[s.chevron, turned(open)]} accessible={false}>
    <ChevronRightAlt className={`size-icon-sm shrink-0 ${faint ? "text-faint-foreground" : "text-row-foreground"}`} />
  </View>
);

/** A row that opens and shuts, its chevron after its words, then `trail`. */
export function Toggle({ open, label, onPress, children, trail }: { open: boolean; label: string; onPress: () => void; children: ReactNode; trail?: ReactNode }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open }} onPress={onPress} hitSlop={6} style={({ pressed }) => [s.line, pressed && { opacity: 0.6 }]}>
      {children}
      <Chevron open={open} />
      {trail ? <View style={s.trail}>{trail}</View> : null}
    </Pressable>
  );
}

/** A row that opens to its detail under it, the desktop's OpeningRow; `trail` shows after its chevron while it's shut. */
export function Opening({ keep, label, children, detail, trail, initial }: { keep: string; label: string; children: ReactNode; detail: ReactNode; trail?: ReactNode; initial?: boolean }) {
  const [open, setOpen] = useKept(keep, initial);
  return (
    <View>
      <Toggle open={open} label={label} onPress={() => setOpen(!open)} trail={open ? undefined : trail}>
        {children}
      </Toggle>
      {open && <View style={s.detail}>{detail}</View>}
    </View>
  );
}

/** The desktop's InfoTip: an ⓘ held to the line, 6 after the words; a tap shows its words (the phone has no hover). */
function Tip({ tip, shown, onPress }: { tip: string; shown: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={tip} accessibilityState={{ expanded: shown }} onPress={onPress} hitSlop={8} style={[s.glyphSm, { marginLeft: space(1.5) }]}>
      <Info className="size-icon-sm text-row-foreground" />
    </Pressable>
  );
}

/**
 * A line across the thread between two hairlines, the desktop's ThreadLine (or InlineStatus, `inline`): its icon held to
 * the first line, the words, an ⓘ showing the rest under it; `live` shimmers.
 */
export function Divider({ icon: Icon, children, tip, live = false, inline = false, after, iconGap = space(2) }: { icon?: ComponentType<IconProps>; children: ReactNode; tip?: string | null; live?: boolean; inline?: boolean; after?: ReactNode; /** After the icon: a ThreadLine's 8, a compaction's 12, a switch's 6. */ iconGap?: number }) {
  const [shown, setShown] = useState(false);
  return (
    <View>
      <View style={s.divider}>
        <View style={s.hair} />
        <View style={[s.middle, inline && { maxWidth: "80%" }]}>
          {Icon && <View style={[s.glyphSm, { marginRight: iconGap }]}><Icon className="size-icon-sm shrink-0 text-row-foreground" /></View>}
          {live && typeof children === "string" ? <Live style={s.center}>{children}</Live> : <Text style={[s.row, s.center]}>{children}</Text>}
          {tip ? <Tip tip={tip} shown={shown} onPress={() => setShown(!shown)} /> : null}
          {after}
        </View>
        <View style={s.hair} />
      </View>
      {shown && tip ? <Text style={[s.small, s.center]}>{tip}</Text> : null}
    </View>
  );
}

/** Something that failed, said calmly: one red line, Try again where it can be, and Details opening the error's own words. */
export function ErrorState({ summary, details, onRetry }: { summary: string; details?: string | null; onRetry?: () => void }) {
  const [open, setOpen] = useState(false);
  const words = details?.trim() ?? "";
  return (
    <View style={{ gap: space(1) }}>
      <View style={s.wrap}>
        <ErrorLine error={summary} />
        {onRetry && (
          <Pressable accessibilityRole="button" onPress={onRetry} hitSlop={6}>
            <Text style={[s.row, { color: color.link }]}>Try again</Text>
          </Pressable>
        )}
        {words ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Details" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} hitSlop={6} style={s.with}>
            <Text style={[s.row, { color: color.mutedForeground }]}>Details</Text>
            <View style={turned(open)}><ChevronRight className="size-icon-xs text-muted-foreground" /></View>
          </Pressable>
        ) : null}
      </View>
      {open && words ? <Text style={[s.code, text.xs, { color: color.liveTextQuiet }]} selectable>{words}</Text> : null}
    </View>
  );
}

/** A red line, the desktop's ErrorLine at size sm; `xs` its default size. */
export const ErrorLine = ({ error, xs = false }: { error: string | null | undefined; xs?: boolean }) =>
  error ? <Text style={[xs ? text.xs : s.row, { color: color.destructive }]} accessibilityRole="alert">{error}</Text> : null;

/** What the phone can't draw yet: one quiet row. */
export const OnMac = () => <Text style={[s.row, s.object]}>Shown on your Mac</Text>;

/** Lines shown before "Show all" on a long output. */
const CAP = 12;

/**
 * Long text in at most 12 lines (the newest with `tail`), a tap showing all of it; `paint` colours a line. The phone's
 * stand-in for the desktop's boxes that scroll past 240: a scroll inside the thread's own scroll doesn't work by touch.
 */
export function Capped({ keep, text: words, tail = false, paint, style }: { keep: string; text: string; tail?: boolean; paint?: (line: string) => TextStyle | undefined; style?: TextStyle }) {
  const [all, setAll] = useKept(`${keep}:all`);
  const lines = words.split("\n");
  const cut = !all && lines.length > CAP;
  const shown = cut ? (tail ? lines.slice(-CAP) : lines.slice(0, CAP)) : lines;
  const more = cut && (
    <Pressable accessibilityRole="button" accessibilityLabel={`Show all ${lines.length.toLocaleString()} lines`} onPress={() => setAll(true)} hitSlop={6}>
      <Text style={[text.xs, { color: color.link }]}>Show all {lines.length.toLocaleString()} lines</Text>
    </Pressable>
  );
  return (
    <View style={{ gap: space(1) }}>
      {tail && more}
      <Text style={[s.code, style]} selectable>
        {paint ? shown.map((line, at) => <Text key={at} style={paint(line)}>{at ? `\n${line}` : line}</Text>) : shown.join("\n")}
      </Text>
      {!tail && more}
    </View>
  );
}

/** A code box, titled or not, the desktop's ToolBox: a tool's input or output, what an approval asked. */
export function Box({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View style={s.box}>
      {title ? <Text style={[text.xs, { color: color.mutedForeground }]}>{title}</Text> : null}
      {children}
    </View>
  );
}

/** The desktop's ROW line: 14 on 21, the rows' grey. */
const LINE = space(5.25);

export const s = StyleSheet.create({
  row: { ...text.sm, lineHeight: LINE, color: color.rowForeground },
  object: { color: color.rowObject },
  small: { ...text.xs, color: color.mutedForeground },
  code: { fontFamily: mono, ...text.code, color: color.foreground },
  shrink: { flexShrink: 1 },
  center: { flexShrink: 1, textAlign: "center" },
  line: { flexDirection: "row", alignItems: "flex-start", gap: space(2), minHeight: LINE },
  wrap: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space(2.5) },
  glyph: { width: space(4), height: LINE, alignItems: "center", justifyContent: "center" },
  glyphSm: { width: space(3.5), height: LINE, alignItems: "center", justifyContent: "center" },
  chevron: { height: LINE, justifyContent: "center", marginLeft: -space(0.5) },
  trail: { flexDirection: "row", alignItems: "center", gap: space(1.5), height: LINE, marginLeft: space(1) },
  // Details and its chevron.
  with: { flexDirection: "row", alignItems: "center", gap: space(1) },
  detail: { gap: space(1), paddingVertical: space(1) },
  divider: { flexDirection: "row", alignItems: "center", gap: space(3), paddingVertical: space(2) },
  middle: { flexDirection: "row", alignItems: "flex-start", flexShrink: 1 },
  hair: { height: 1, flex: 1, backgroundColor: color.border },
  box: { borderRadius: radius.control, backgroundColor: color.codeSurface, paddingHorizontal: space(3), paddingVertical: space(2) },
  // An opened group's steps: 12 apart on a rule under the row's icon, each at its words' start [D95].
  steps: { marginLeft: space(2), marginTop: space(3), gap: space(3), borderLeftWidth: 1, borderLeftColor: color.divider, paddingLeft: space(3.75) },
});
