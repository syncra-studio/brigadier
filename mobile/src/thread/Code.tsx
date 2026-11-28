import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { FOLDED_LINES, foldWords, isProse, languageName, LONG_LINES, linesWords } from "../../../app/shared/code";
import { ChevronDown, ChevronUp, Code } from "../../../app/ui/src/icons";
import { color, fontWeight, mono, radius, space, spacing, text } from "../theme";

/**
 * A reply's code block, as the desktop's thread/code.tsx draws it: its language over the code, folded when long.
 * Phone-only: no copy or wrap button (the text is selectable) and no colouring.
 */
export function CodeBlock({ code, language }: { code: string; language: string }) {
  // shortcut: the fold isn't kept when the row scrolls away, as the desktop's useKept; key it if a long reply needs it.
  const [open, setOpen] = useState(false);
  const count = code.split("\n").length;
  const long = count > LONG_LINES;
  const shown = long && !open ? code.split("\n", FOLDED_LINES).join("\n") : code;
  const body = <Text style={st.code} selectable>{shown}</Text>;
  return (
    <View style={st.card}>
      <View style={st.head}>
        <Code className="size-icon-sm text-chat-foreground" />
        <Text style={st.name}>{languageName(language)}</Text>
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

const st = StyleSheet.create({
  card: { overflow: "hidden", borderRadius: radius.thread, borderWidth: 1, borderColor: color.codeCardEdge, backgroundColor: color.codeCard },
  head: { flexDirection: "row", alignItems: "center", height: space(12), gap: space(2), paddingStart: space(5), paddingEnd: space(1.5) },
  name: { ...text.sm, fontWeight: fontWeight.medium, color: color.chatForeground },
  lines: { ...text.sm, color: color.mutedForeground },
  pre: { paddingHorizontal: space(5), paddingBottom: space(3) },
  code: { ...text.code, fontFamily: mono, color: color.chatForeground },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: space(11.5), experimental_backgroundImage: `linear-gradient(to top, ${color.codeCard}, transparent)` },
  fold: { flexDirection: "row", alignItems: "center", height: spacing.controlMd, gap: space(1.5), paddingHorizontal: space(3), borderTopWidth: 1, borderTopColor: color.divider },
  foldWords: { ...text.xs, color: color.mutedForeground },
});
