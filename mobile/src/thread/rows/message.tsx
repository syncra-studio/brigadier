// The messages, after the desktop's components/thread/message.tsx, peers/message.tsx and thread/tidy.ts.
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Item } from "../../../../app/shared/thread";
import { sentAt } from "../../../../app/shared/words";
import { ReplyImages } from "../../powers/View";
import { color } from "../../theme";
import { ThreadImage } from "../Image";
import { Markdown } from "../Markdown";
import { Glyph, Opening, s, useKept, Words } from "./parts";

type Message = Extract<Item, { kind: "message" }>;

/** A user's message past this many lines folds with Show more. */
const FOLD_LINES = 20;
const PASTE_LABEL = "Pasted text";
const PR_FIX = /^(Merge conflicts|Review comments) – PR #\d+$|^\d+ failing checks? · /;

/** The user's message on the right in its bubble, its files over it and its time under it [D85, D86]. */
export function UserBubble({ item }: { item: Message }) {
  const words = item.draft?.shell ? "```sh\n" + item.draft.shell + "\n```" : item.text;
  const [more, setMore] = useKept(`${item.id}:more`);
  const lines = words.split("\n");
  const folds = lines.length > FOLD_LINES;
  // The desktop shows an image or paste chip in the text instead [D2107]; the phone draws no chips, so all go above.
  const files = item.files ?? [];
  const fix = item.draft?.parts.some((part) => typeof part !== "string" && part.kind === "paste" && PR_FIX.test(part.preview ?? ""));
  return (
    <View style={st.user}>
      {files.length > 0 && (
        <View style={st.files} accessibilityLabel="Attachments">
          {files.map((file) =>
            file.mime.startsWith("image/") ? (
              <ThreadImage key={file.id} attachment={file.id} mime={file.mime} label={file.name} style={st.image} />
            ) : (
              <Text key={file.id} style={st.file} numberOfLines={1}>{file.pasted ? PASTE_LABEL : file.name}</Text>
            ),
          )}
        </View>
      )}
      {fix && <Text style={s.small}>PR fix</Text>}
      {(words.trim() !== "" || files.length === 0) && (
        <View style={st.bubble}>
          <Markdown text={folds && !more ? lines.slice(0, FOLD_LINES).join("\n") : words} />
          {folds && (
            <Pressable accessibilityRole="button" accessibilityLabel={more ? "Show less" : "Show more"} accessibilityState={{ expanded: more }} onPress={() => setMore(!more)} hitSlop={6}>
              <Text style={[s.small, { paddingTop: 4 }]}>{more ? "Show less ⌃" : "Show more ⌄"}</Text>
            </Pressable>
          )}
        </View>
      )}
      {item.sentAt !== undefined && <Text style={[s.small, st.time]}>{sentAt(item.sentAt)}</Text>}
    </View>
  );
}

/** Another session's message, in the user's bubble, captioned with who sent it; never the user [D2034]. */
export function PeerBubble({ item }: { item: Message }) {
  // shortcut: the phone has no session list here, so every sender reads as the desktop's gone one, "a session".
  return (
    <View style={st.user} accessibilityLabel="Message from a session:">
      <Text style={s.small}>Sent by a session from another session</Text>
      <View style={st.bubble}>
        <Markdown text={item.text} />
      </View>
      {item.sentAt !== undefined && <Text style={[s.small, st.time]}>{sentAt(item.sentAt)}</Text>}
    </View>
  );
}

/** The agent's message, an image path in it shown when tapped; under a turn's final answer, its time. */
export function AssistantMessage({ item, final }: { item: Message; final: boolean }) {
  return (
    <View style={{ gap: 6 }}>
      <ReplyImages keep={item.id}>
        <Markdown text={tidy(item.text)} />
      </ReplyImages>
      {final && <AnswerMarks time={item.sentAt} />}
    </View>
  );
}

/** A finished answer's marks: only its time on the phone (Copy, Save as note and Fork are the Mac's). */
export function AnswerMarks({ time }: { time?: number }) {
  return time === undefined ? null : <Text style={[s.small, { color: color.faintForeground }]}>{sentAt(time)}</Text>;
}

/** The live "Thinking" line: the thought's newest heading if there is one. */
export function ThinkingLine({ heading }: { heading?: string | null }) {
  return <Text style={[s.row, { color: color.foreground }]} numberOfLines={2} accessibilityLiveRegion="polite">{heading || "Thinking"}</Text>;
}

/** A thought's line: its heading or first words, opening to the whole thought [D752]. */
export function ThoughtRow({ item }: { item: Extract<Item, { kind: "reasoning" }> }) {
  const words = item.heading || item.text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim() || "Thought";
  return (
    <Opening keep={item.id} label={words} detail={<View style={{ paddingLeft: 24 }}><Markdown text={item.text} style={{ color: color.mutedForeground }} /></View>}>
      <Glyph g="✱" />
      <Words verb={words} />
    </Opening>
  );
}

const SHELL = /^(sh|bash|zsh|shell|console)$/i;

/** Given a text's lines in turn, the language of the fence each opens or is inside, a quote's too; null outside code. */
function fenceWalk(): (line: string) => string | null {
  let mark = "";
  let language = "";
  let depth = 0;
  return (line) => {
    const quotes = /^(?:\s*>)*/.exec(line)![0].split(">").length - 1;
    if (quotes < depth) mark = "";
    if (!mark) depth = quotes;
    const fence = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(line.split(">").slice(depth).join(">"));
    if (fence && !mark) [mark, language] = [fence[1]!, fence[2]!];
    else if (fence && fence[1]!.startsWith(mark) && !fence[2]) mark = "";
    return mark ? language : null;
  };
}

/**
 * A reply's shape repaired where agents slip, as the desktop's tidy [D525, D529, D530]: a shell block's `$ ` prompts
 * go, only the first warning stays a callout, a `#` or `##` heading reads as `###`, a line that starts in bold reads plain.
 */
export function tidy(text: string): string {
  const codeAt = fenceWalk();
  let warned = false;
  return text
    .split("\n")
    .map((line) => {
      const language = codeAt(line);
      if (language !== null) return SHELL.test(language) ? line.replace(/^(\s*)\$ /, "$1") : line;
      if (/^\s*>\s*\[!(WARNING|CAUTION)\]/.test(line)) {
        if (warned) return line.replace(/\[!(WARNING|CAUTION)\]\s*/, "");
        warned = true;
        return line;
      }
      return line.replace(/^#{1,2} /, "### ").replace(/^\*\*([^*\n]+)\*\*/, "$1");
    })
    .join("\n");
}

const st = StyleSheet.create({
  user: { alignItems: "flex-end", gap: 4 },
  bubble: { maxWidth: "85%", borderRadius: 18, backgroundColor: color.bubble, paddingHorizontal: 16, paddingVertical: 10 },
  files: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, maxWidth: "85%" },
  image: { width: 120, height: 120, borderRadius: 10 },
  file: { fontSize: 13, lineHeight: 18, color: color.foreground, backgroundColor: color.muted, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, maxWidth: 220 },
  time: { color: color.faintForeground },
});
