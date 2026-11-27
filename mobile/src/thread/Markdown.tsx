// shortcut: a small markdown subset, no tables or nested lists; upgrade if the owner wants them.
import type { ReactNode } from "react";
import { Linking, ScrollView, StyleSheet, Text, type TextStyle, View } from "react-native";
import { color, mono, text as type } from "../theme";

type Block =
  | { type: "p" | "quote"; text: string }
  | { type: "h"; level: number; text: string }
  | { type: "code"; text: string }
  | { type: "list"; ordered: boolean; items: { mark: string; text: string }[] };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?/;

function blocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.split("\n");
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!;
    const fence = FENCE.exec(line);
    if (fence) {
      // An unclosed fence runs to the end: a streaming reply's code still arriving.
      const code: string[] = [];
      while (++at < lines.length && !CLOSE.exec(lines[at]!)?.[1]!.startsWith(fence[1]!)) code.push(lines[at]!);
      out.push({ type: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) continue;
    const last = out.at(-1);
    const after = at > 0 && lines[at - 1]!.trim() !== "";
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ type: "h", level: heading[1]!.length, text: heading[2]! });
      continue;
    }
    if (QUOTE.test(line)) {
      // A GitHub alert's marker reads as nothing: the quote's bar says it's apart.
      const words = line.replace(/^(\s*>\s?)+/, "").replace(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/, "");
      if (last?.type === "quote" && after) last.text += words ? `\n${words}` : "";
      else if (words) out.push({ type: "quote", text: words });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[1]!);
      const entry = { mark: ordered ? item[1]!.replace(")", ".") : "•", text: item[2]! };
      if (last?.type === "list" && last.ordered === ordered) last.items.push(entry);
      else out.push({ type: "list", ordered, items: [entry] });
      continue;
    }
    // Every line break kept, as the desktop's remark-breaks.
    if (last?.type === "list" && (after || /^\s{2,}/.test(line))) last.items.at(-1)!.text += `\n${line.trim()}`;
    else if (last?.type === "p" && after) last.text += `\n${line}`;
    else out.push({ type: "p", text: line });
  }
  return out;
}

// Code spans, bold, links, italics and bare web addresses, in that order of precedence.
const INLINE = /`([^`\n]+)`|\*\*(.+?)\*\*|__(.+?)__|\[([^\[\]\n]+)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)|\*([^*\s](?:[^*\n]*[^*\s])?)\*|\b_([^_\n]+?)_\b|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_])/g;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}.${n++}`;
    if (m[1] !== undefined) out.push(<Text key={k} style={st.inlineCode}>{m[1]}</Text>);
    else if (m[2] !== undefined || m[3] !== undefined) out.push(<Text key={k} style={st.bold}>{inline(m[2] ?? m[3]!, k)}</Text>);
    else if (m[4] !== undefined) out.push(<Link key={k} url={m[5]!}>{inline(m[4], k)}</Link>);
    else if (m[6] !== undefined || m[7] !== undefined) out.push(<Text key={k} style={st.italic}>{inline(m[6] ?? m[7]!, k)}</Text>);
    else out.push(<Link key={k} url={m[8]!}>{m[8]}</Link>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A link that opens in its app; a path in the checkout can't open on the phone, so it reads as text. */
function Link({ url, children }: { url: string; children: ReactNode }) {
  const web = /^(https?:|mailto:)/i.test(url);
  if (!web) return <Text style={st.inlineCode}>{children}</Text>;
  return (
    <Text style={st.link} accessibilityRole="link" accessibilityHint={url} onPress={() => void Linking.openURL(url)}>
      {children}
    </Text>
  );
}

/** Markdown drawn in `style`'s text: an answer's, or the user's bubble's. */
export function Markdown({ text, style }: { text: string; style?: TextStyle }) {
  const base = [st.text, style];
  return (
    <View style={st.blocks}>
      {blocks(text).map((block, at) => {
        const key = String(at);
        switch (block.type) {
          case "p":
            return <Text key={key} style={base} selectable>{inline(block.text, key)}</Text>;
          case "quote":
            return (
              <View key={key} style={st.quote}>
                <Text style={[base, { color: color.mutedForeground }]} selectable>{inline(block.text, key)}</Text>
              </View>
            );
          case "h":
            return <Text key={key} accessibilityRole="header" style={[base, block.level <= 2 ? type.lg : null, st.heading]}>{inline(block.text, key)}</Text>;
          case "code":
            return (
              <ScrollView key={key} horizontal style={st.code} contentContainerStyle={st.codeIn}>
                <Text style={st.codeText} selectable>{block.text}</Text>
              </ScrollView>
            );
          case "list":
            return (
              <View key={key} style={st.list}>
                {block.items.map((item, n) => (
                  <View key={n} style={st.item}>
                    <Text style={[base, st.mark]}>{item.mark}</Text>
                    <Text style={[base, st.grow]} selectable>{inline(item.text, `${key}.${n}`)}</Text>
                  </View>
                ))}
              </View>
            );
        }
      })}
    </View>
  );
}

const st = StyleSheet.create({
  blocks: { gap: 12 },
  text: { ...type.base, color: color.chat },
  heading: { fontWeight: "600" },
  bold: { fontWeight: "600" },
  italic: { fontStyle: "italic" },
  link: { color: color.link },
  inlineCode: { fontFamily: mono, fontSize: 13, backgroundColor: color.fill, color: color.foreground },
  code: { borderRadius: 8, backgroundColor: color.codeSurface, flexGrow: 0 },
  codeIn: { paddingHorizontal: 12, paddingVertical: 10 },
  codeText: { fontFamily: mono, fontSize: 12.5, lineHeight: 18, color: color.foreground },
  quote: { borderLeftWidth: 2, borderLeftColor: color.muted, paddingLeft: 12 },
  list: { gap: 4 },
  item: { flexDirection: "row", gap: 6 },
  mark: { minWidth: 14, color: color.mutedForeground },
  grow: { flex: 1 },
});
