import { type ReactNode, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, type TextStyle, View } from "react-native";
import { FOLDED_LINES, foldWords, isProse, languageName, LONG_LINES, linesWords } from "../../../app/shared/code";
import { highlight } from "../../../app/shared/highlight";
import { ChevronDown, ChevronUp, Code, FENCE_ICONS } from "../../../app/ui/src/icons";
import { color, fontWeight, mono, radius, space, spacing, syntax, text } from "../theme";

/**
 * A reply's code block, as the desktop's thread/code.tsx draws it: its language (or `title`, the words after it, by
 * its kind's icon) over the code, coloured once it settles, folded when long.
 * Phone-only: no copy or wrap button (the text is selectable).
 */
export function CodeBlock({ code, language, title }: { code: string; language: string; title?: string }) {
  // shortcut: the fold isn't kept when the row scrolls away, as the desktop's useKept; key it if a long reply needs it.
  const [open, setOpen] = useState(false);
  const count = code.split("\n").length;
  const long = count > LONG_LINES;
  const shown = long && !open ? code.split("\n", FOLDED_LINES).join("\n") : code;
  const html = useHighlight(shown, language);
  const body = <Text style={st.code} selectable>{html === null ? shown : draw(runs(html))}</Text>;
  const Icon = (title && FENCE_ICONS[language]) || Code;
  return (
    <View style={st.card}>
      <View style={st.head}>
        <Icon className="size-icon-sm text-chat-foreground" />
        <Text style={[st.name, title ? { color: color.foreground } : null]} numberOfLines={1}>{title ?? languageName(language)}</Text>
        {long ? <Text style={st.lines}>{linesWords(count)}</Text> : null}
      </View>
      <View>
        {isProse(language) ? <View style={st.pre}>{body}</View> : <ScrollView horizontal contentContainerStyle={st.pre}>{body}</ScrollView>}
        {long && !open ? <View pointerEvents="none" style={st.fade} /> : null}
      </View>
      {long ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={st.fold}>
          {open ? <ChevronUp className="size-icon-sm text-muted-foreground" /> : <ChevronDown className="size-icon-sm text-muted-foreground" />}
          <Text style={st.foldWords}>{foldWords(open, count)}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The highlighter's escaped HTML for `code`, once it has stopped changing for a moment; null until then. */
function useHighlight(code: string, language: string): string | null {
  const [done, setDone] = useState<{ code: string; html: string | null } | null>(null);
  useEffect(() => {
    if (!language) return;
    let live = true;
    const timer = setTimeout(() => {
      highlight(code, language).then(
        (html) => live && setDone({ code, html }),
        () => live && setDone({ code, html: null }),
      );
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [code, language]);
  return done?.code === code ? done.html : null;
}

/** A piece of the highlighter's HTML: text, or a span in its classes' colour. */
type Run = string | { style: TextStyle; runs: Run[] };
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'" };
const looks = new Map<string, TextStyle>();
/** A span's colour and fill as code.css gives its classes: every rule they match, the more specific over the rest. */
function lookOf(classes: string): TextStyle {
  const mine = new Set(classes.split(" "));
  const hits = Object.keys(syntax).filter((selector) => selector.split(".").every((name) => mine.has(name)));
  hits.sort((a, b) => a.split(".").length - b.split(".").length);
  return Object.assign({}, ...hits.map((selector) => syntax[selector]));
}
function runs(html: string): Run[] {
  const root: Run[] = [];
  const open = [root];
  for (const [, classes, words] of html.matchAll(/<span class="([^"]*)">|<\/span>|([^<]+)/g)) {
    if (words !== undefined) open.at(-1)!.push(words.replace(/&(amp|lt|gt|quot|#x27);/g, (_, name: string) => ENTITIES[name]!));
    else if (classes !== undefined) {
      if (!looks.has(classes)) looks.set(classes, lookOf(classes));
      const span = { style: looks.get(classes)!, runs: [] };
      open.at(-1)!.push(span);
      open.push(span.runs);
    } else if (open.length > 1) open.pop();
  }
  return root;
}
const draw = (list: Run[]): ReactNode[] => list.map((run, at) => (typeof run === "string" ? run : <Text key={at} style={run.style}>{draw(run.runs)}</Text>));

const st = StyleSheet.create({
  card: { overflow: "hidden", borderRadius: radius.thread, borderWidth: 1, borderColor: color.codeCardEdge, backgroundColor: color.codeCard },
  head: { flexDirection: "row", alignItems: "center", height: space(12), gap: space(2), paddingStart: space(5), paddingEnd: space(1.5) },
  name: { ...text.sm, flexShrink: 1, fontWeight: fontWeight.medium, color: color.chatForeground },
  lines: { ...text.sm, color: color.mutedForeground },
  pre: { paddingHorizontal: space(5), paddingBottom: space(3) },
  code: { ...text.code, fontFamily: mono, color: color.chatForeground },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: space(11.5), experimental_backgroundImage: `linear-gradient(to top, ${color.codeCard}, transparent)` },
  fold: { flexDirection: "row", alignItems: "center", height: spacing.controlMd, gap: space(1.5), paddingHorizontal: space(3), borderTopWidth: 1, borderTopColor: color.divider },
  foldWords: { ...text.xs, color: color.mutedForeground },
});
