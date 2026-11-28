// A reply's cards, as the desktop's thread/reply-cards.tsx draws them: a draft folded to one row that opens in place,
// a message for someone else, words to paste [D477, D520, D563]. Phone-only: no Copy (the words are selectable).
import { type ReactNode, useState } from "react";
import { Pressable, StyleSheet, Text, type TextStyle, View } from "react-native";
import { type Message, peek, wroteWords } from "../../../app/shared/markdown";
import { Chat, ChevronDown, ChevronUp } from "../../../app/ui/src/icons";
import { color, fontWeight, leading, radius, space, spacing, text } from "../theme";

/** A draft folded to one row: its kind and title, its first line, a chevron; a press opens it in place. */
export function Draft({ icon, title, text: words, children }: { icon?: ReactNode; title: string; text: string; children: ReactNode }) {
  // shortcut: the fold isn't kept when the row scrolls away, as the desktop's useKept; key it if a long reply needs it.
  const [open, setOpen] = useState(false);
  return (
    <View style={st.frame}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={st.row}>
        {icon}
        <Text style={st.title} numberOfLines={1}>{title}</Text>
        {!open ? <Text style={st.peek} numberOfLines={1}>{peek(words)}</Text> : null}
        <View style={st.end}>{open ? <ChevronUp className="size-icon-sm text-muted-foreground" /> : <ChevronDown className="size-icon-sm text-muted-foreground" />}</View>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

/** The words as written, in the reply's own font (`base`). */
const Said = ({ base, children }: { base: TextStyle; children: string }) => (
  <Text style={[base, st.said, { lineHeight: (base.fontSize ?? text.chat.fontSize) * leading.relaxed }]} selectable>
    {children}
  </Text>
);

/** Words for a person to paste (a `text` fence): its title, the words as written [D520]. */
export const WritingCard = ({ title, text: words, base }: { title: string; text: string; base: TextStyle }) => (
  <Draft title={title} text={words}>
    <Said base={base}>{words}</Said>
  </Draft>
);

const ChatMark = () => <Chat className="size-icon-sm shrink-0 text-muted-foreground" />;

/** A message for someone else: where it goes, their words it answers, the message. */
export const MessageCard = ({ to, text: words, quote, base }: Message & { base: TextStyle }) => (
  <Draft icon={<ChatMark />} title={to} text={words}>
    {quote ? (
      <View style={st.quote}>
        <Text style={[st.quoteText, st.wrote]}>{wroteWords(quote.from)}</Text>
        <Text style={st.quoteText} selectable>{quote.text}</Text>
      </View>
    ) : null}
    <Said base={base}>{words}</Said>
  </Draft>
);

/** A message card's frame while its JSON still arrives, so the JSON never shows raw [D520]. */
export const MessageFrame = () => (
  <View style={st.frame}>
    <View style={st.row}>
      <ChatMark />
    </View>
  </View>
);

const st = StyleSheet.create({
  frame: { borderRadius: radius.thread, borderWidth: 1, borderColor: color.codeCardEdge, backgroundColor: color.codeCard },
  row: { flexDirection: "row", alignItems: "center", height: spacing.controlMd, gap: space(1.5), paddingStart: space(4), paddingEnd: space(2) },
  title: { ...text.xs, maxWidth: "50%", flexShrink: 0, fontWeight: fontWeight.medium, color: color.foreground },
  peek: { ...text.xs, flexShrink: 1, marginStart: space(1), color: color.mutedForeground },
  end: { marginStart: "auto" },
  said: { paddingHorizontal: space(4), paddingBottom: space(4) },
  quote: { marginHorizontal: space(4), marginBottom: space(2), paddingStart: space(3), borderStartWidth: 2, borderStartColor: color.quoteEdge },
  quoteText: { ...text.sm, color: color.mutedForeground },
  wrote: { ...text.xs, fontWeight: fontWeight.medium },
});
