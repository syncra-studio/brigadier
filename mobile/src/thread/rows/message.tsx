// The messages, after the desktop's components/thread/message.tsx and peers/message.tsx.
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PASTE_LABEL, PR_FIX } from "../../../../app/shared/chips";
import { UNKNOWN_SESSION, sentByCaption } from "../../../../app/shared/peers";
import { kindOf } from "../../../../app/shared/session/composer";
import type { Item, SentFile } from "../../../../app/shared/thread";
import { sentAt } from "../../../../app/shared/words";
import { tidy } from "../../../../app/shared/markdown";
import { Chat, ChevronRightAlt, FileDocument, FileImage, Lightbulb, Paperclip } from "../../../../app/ui/src/icons";
import { Card } from "../../compose/parts";
import { lists, thread } from "../../mac/mac";
import { ReplyImages } from "../../powers/View";
import { color, radius, space, spacing, text } from "../../theme";
import { ThreadImage } from "../Image";
import { Markdown } from "../Markdown";
import { Live, Opening, s, StepIcon, useKept, Words } from "./parts";

type Message = Extract<Item, { kind: "message" }>;

/** A user's message past this many lines folds with Show more. */
const FOLD_LINES = 20;

/** The user's message: its files over it, and over those "PR fix" when it asks to repair a PR [D171, D2107]. */
export function UserBubble({ item }: { item: Message }) {
  const words = item.draft?.shell ? "```sh\n" + item.draft.shell + "\n```" : item.text;
  const files = item.files ?? [];
  // The desktop shows an image or paste chip in the text instead [D2107]; the phone draws no chips, so all go above.
  const fix = item.draft?.parts.some((part) => typeof part !== "string" && part.kind === "paste" && PR_FIX.test(part.preview ?? ""));
  const above = (files.length > 0 || fix) && (
    <>
      {files.length > 0 && <Files files={files} />}
      {fix && <Text style={[text.sm, { color: color.mutedForeground }]}>PR fix</Text>}
    </>
  );
  return <Bubble keep={item.id} text={words} time={item.sentAt} files={above || undefined} />;
}

/** A message's files, over its bubble, as the desktop's SentAttachments: images as squares, others as cards. */
function Files({ files }: { files: readonly SentFile[] }) {
  return (
    <View style={st.files} accessibilityLabel="Attachments">
      {files.map((file) => {
        if (file.mime.startsWith("image/")) {
          return (
            <View key={file.id} style={st.image}>
              <ThreadImage attachment={file.id} mime={file.mime} label={file.name} style={StyleSheet.absoluteFill} />
              <View pointerEvents="none" style={st.ring} />
            </View>
          );
        }
        const Kind = file.mime.startsWith("text/") || file.mime === "application/pdf" ? FileDocument : file.mime.startsWith("image/") ? FileImage : Paperclip;
        return <Card key={file.id} icon={<Kind className="size-icon-md" />} title={file.pasted ? PASTE_LABEL : file.name} detail={kindOf(file.name, file.mime)} />;
      })}
    </View>
  );
}

/**
 * The user's bubble on the right, its Markdown with every line break kept [D85]: `files` over it, its time under it,
 * folding past 20 lines with Show more.
 */
function Bubble({ keep, text: words, time, files }: { keep: string; text: string; time?: number; files?: ReactNode }) {
  const [more, setMore] = useKept(`${keep}:more`);
  const lines = words.split("\n");
  const folds = lines.length > FOLD_LINES;
  return (
    <View style={st.user}>
      <View style={st.column}>
        {files}
        {/* A message of only files (a paste, an image) has no bubble under them. */}
        {(words.trim() !== "" || !files) && (
          <View style={st.bubble}>
            <Markdown bubble text={folds && !more ? lines.slice(0, FOLD_LINES).join("\n") : words} />
            {folds && (
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: more }} onPress={() => setMore(!more)} hitSlop={6} style={st.more}>
                <Text style={[text.xs, { color: color.mutedForeground }]}>{more ? "Show less" : "Show more"}</Text>
                <View style={{ transform: [{ rotate: more ? "-90deg" : "90deg" }] }}><ChevronRightAlt className="size-icon-xs text-muted-foreground" /></View>
              </Pressable>
            )}
          </View>
        )}
        {/* Its time in view: the phone has no hover to show it on. Copy and Edit are the Mac's. */}
        {time !== undefined && <View style={st.actions}><Text style={st.time}>{sentAt(time)}</Text></View>}
      </View>
    </View>
  );
}

/** Another session's message, in the user's bubble, captioned with who sent it; never the user [D2034]. */
export function PeerBubble({ item }: { item: Message }) {
  const from = useSyncExternalStore(lists.subscribe, () => lists.get().rows.find((row) => row.id === item.from));
  const worker = Boolean(from && from.worker?.parent === thread.get()?.id);
  const title = from ? from.title || "New session" : UNKNOWN_SESSION;
  const caption = (
    <View style={st.caption}>
      <Chat className="size-3.5 shrink-0 text-muted-foreground" />
      <Text style={[text.peerCaption, st.captionText]} numberOfLines={1}>{sentByCaption(title, worker)}</Text>
    </View>
  );
  return (
    <View accessibilityLabel={`Message from ${title}:`}>
      <Bubble keep={`peer:${item.sentAt ?? 0}`} text={item.text} time={item.sentAt ?? 0} files={caption} />
    </View>
  );
}

/** The agent's message, an image path in it shown when tapped; under a turn's final answer, its marks. */
export function AssistantMessage({ item, final }: { item: Message; final: boolean }) {
  return (
    <View style={{ gap: space(1.5) }}>
      <ReplyImages keep={item.id}>
        <Markdown text={tidy(item.text)} />
      </ReplyImages>
      {final && <AnswerMarks time={item.sentAt} />}
    </View>
  );
}

/** A finished answer's marks: its time (Copy, Save as note and Fork are the Mac's). */
export function AnswerMarks({ time }: { time?: number }) {
  return time === undefined ? null : <View style={st.marks}><Text style={[st.time, { color: color.faintForeground }]}>{sentAt(time)}</Text></View>;
}

/** The live "Thinking" line: the thought's newest heading if there is one. */
export function ThinkingLine({ heading }: { heading?: string | null }) {
  return <View accessibilityLiveRegion="polite"><Live key={heading || "Thinking"}>{heading || "Thinking"}</Live></View>;
}

/** A thought's line: its heading or first words, opening to the whole thought [D752]. */
export function ThoughtRow({ item }: { item: Extract<Item, { kind: "reasoning" }> }) {
  const words = item.heading || item.text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim() || "Thought";
  return (
    <Opening keep={item.id} label={words} detail={<View style={{ paddingLeft: space(6) }}><Markdown text={item.text} style={{ color: color.rowForeground }} /></View>}>
      <StepIcon icon={Lightbulb} />
      <Words verb={words} />
    </Opening>
  );
}

const st = StyleSheet.create({
  user: { alignItems: "flex-end", gap: space(1) },
  column: { maxWidth: "70%", alignItems: "flex-end", gap: space(1) },
  bubble: { maxWidth: "100%", borderRadius: radius.thread, backgroundColor: color.bubble, paddingHorizontal: space(4), paddingVertical: space(2.5) },
  files: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "flex-end", gap: space(2) },
  image: { width: spacing.attachmentSent, height: spacing.attachmentSent, overflow: "hidden", borderRadius: radius.surface, backgroundColor: color.muted },
  ring: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: radius.surface, borderWidth: 1, borderColor: color.border },
  more: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: space(0.5), paddingTop: space(1) },
  actions: { flexDirection: "row", alignItems: "center", marginBottom: space(1) },
  time: { ...text.xs, color: color.mutedForeground, fontVariant: ["tabular-nums"] },
  marks: { flexDirection: "row", alignItems: "center", marginLeft: -space(1), paddingLeft: space(1.5) },
  caption: { flexDirection: "row", alignItems: "center", gap: space(1), maxWidth: "100%" },
  captionText: { flexShrink: 1, color: color.mutedForeground },
});
