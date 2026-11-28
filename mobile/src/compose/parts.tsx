// The composer's types and helpers, its field, tiles and messages on their way, and its styles.
import { useEffect, useRef, useState } from "react";
import { Animated, Modal, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { agentChipWords, type Chip as PanelChip, commentAt } from "../../../app/shared/chips";
import { type Chip, type Draft, plainText } from "../../../app/shared/draft";
import type { ModelRow } from "../../../app/shared/session/model";
import type { RustQueued } from "../../../app/shared/session/queued";
import type { Going } from "../../../app/shared/session/uncertain";
import { baseName, COMPOSER_WORDS, kindOf } from "../../../app/shared/session/composer";
import { color, spacing, radius, text, shadow, opacity, mono, night } from "../theme";
import { Comment, FileDocument, FileImage, Paperclip, Spinner, Warning, X } from "../../../app/ui/src/icons";
import { Terminal } from "../../../app/ui/src/icons/thread";
import { Sparkles, XCircle } from "../../../app/ui/src/landing/icons";
import { Spin, usePulse } from "./motion";
import { chipTone, NEW_SESSION } from "./Menus";
import { ThreadImage } from "../thread/Image";
import { type Attachment, forMac } from "./state";

/** A session's row with what the composer needs from Rust, as the desktop's ComposerRow. */
export type ComposerRow = ModelRow & {
  /** `editing`: the message pulled back to edit, kept by Rust; any device's. */
  queue?: { paused: boolean; items: RustQueued[]; editing?: { id: string; text: string; parts?: Draft; slot: number; to?: string; shell?: string } | null; running?: string[] } | null;
  steer?: boolean;
  /** The last turn was the user's Stop: Resume carries it on [D373]. */
  resumable?: boolean;
  holding?: boolean;
  /** A rebirth under way: its turn being stopped, or its fresh conversation not yet started [D88, D112]. */
  optimizing?: boolean;
};

/** One queue action, shown at once until its reply is in and Rust's row has caught up with it (`touched`). */
export type Op = { key: string; kind: "add" | "remove" | "resume" | "move"; qid: string; text?: string; slot?: number; at?: number; done?: () => void };
/** The field's draft a message was sent from, its revision then, and its chips: what Rust gives back if it's refused. */
export type Sub = { draft: Draft; rev: number | null; chips: readonly PanelChip[] };
export type Pulled = { qid: string; slot: number; text: string } | null;

/** A chip in the text, which shows there as its label. */
export type Named = Extract<Chip, { label: string }>;
export const named = (part: Draft["parts"][number]): part is Named => typeof part !== "string" && "label" in part;
/** A draft's files: its tiles, and its image and paste chips as tiles too, since the field shows no chip without a label. */
export const tilesOf = (draft: Draft) => [...new Set([...draft.attachmentIds, ...draft.parts.flatMap((part) => (typeof part !== "string" && "attachmentId" in part ? [part.attachmentId] : []))])];

/** The field's text as a draft's parts: each chip still whole in it is a chip again, the rest words. */
export function partsOf(words: string, chips: readonly Named[]): Draft["parts"] {
  const found: { chip: Named; at: number }[] = [];
  for (const chip of chips) {
    const n = chip.label.length;
    for (let at = words.indexOf(chip.label); n > 0 && at >= 0; at = words.indexOf(chip.label, at + 1)) {
      if (found.some((each) => at < each.at + each.chip.label.length && each.at < at + n)) continue;
      found.push({ chip, at });
      break;
    }
  }
  found.sort((a, b) => a.at - b.at);
  const parts: Draft["parts"] = [];
  let from = 0;
  for (const { chip, at } of found) {
    if (at > from) parts.push(words.slice(from, at));
    parts.push(chip);
    from = at + chip.label.length;
  }
  if (from < words.length) parts.push(words.slice(from));
  return parts;
}


/** A reply lost with the link: what it asked may have been done. */
export const lostReply = (reply: Record<string, any>) => reply.error === "closed" || reply.error === "disconnected";
/** The failure that came last of `errors`, each a source's own; once it's cleared, any other still there. */
export function useLatest(errors: (string | null)[]): string | null {
  const seen = useRef<(string | null)[]>([]);
  const [latest, setLatest] = useState<string | null>(null);
  useEffect(() => {
    const fresh = errors.find((each, at) => each && each !== seen.current[at]);
    seen.current = errors;
    if (fresh) setLatest(fresh);
    else if (latest !== null && !errors.includes(latest)) setLatest(errors.find(Boolean) ?? null);
  });
  return latest;
}

/** Not a definite refusal: no answer, or one that says the worker's host may have it (`answered: false`, its I/O failing). */
export const unsure = (reply: Record<string, any>) => lostReply(reply) || reply.answered === false;
/** Stopped before the command ran: the Mac's Face ID gate turned it down, so what it asked wasn't done. */
export const unsigned = (reply: Record<string, any>) => ["Needs Face ID", "Turned off for this iPhone on your Mac", "no randomness"].includes(String(reply.error));
/** The worker a To: sends to, its name as it was picked. */
export type To = { id: string; name: string };
export const isNew = (part: Draft["parts"][number]) => typeof part !== "string" && part.kind === "command" && part.id === NEW_SESSION.id;

/**
 * The field, as the desktop's field.tsx: at least 44 tall, a quarter of the screen at most, then it scrolls and fades
 * at its top; each chip in its kind's colour. A command shows without its `!`, in mono after the Terminal icon;
 * Backspace in an empty one leaves the mode, as deleting the `!` would.
 */
export function Field({ words, chips, shell, placeholder, night, onChange, onCursor }: { words: string; chips: readonly Named[]; shell: boolean; placeholder: string; night: boolean; onChange: (next: string) => void; onCursor: (at: number) => void }) {
  const { height } = useWindowDimensions();
  const [scrolled, setScrolled] = useState(false);
  const under = night && !shell ? color.surfaceUnder : color.composer;
  return (
    <View>
      {shell ? (
        <View style={st.terminal} pointerEvents="none">
          <Terminal className="size-icon-md text-link" />
        </View>
      ) : null}
      <TextInput
        style={[st.input, { maxHeight: height * 0.25 }, shell && st.mono]}
        multiline
        placeholder={placeholder}
        placeholderTextColor={color.placeholder}
        onChangeText={(next) => onChange(shell ? `!${next}` : next)}
        onKeyPress={(event) => shell && words === "!" && event.nativeEvent.key === "Backspace" && onChange("")}
        onSelectionChange={(event) => onCursor(event.nativeEvent.selection.end)}
        onScroll={(event) => setScrolled(event.nativeEvent.contentOffset.y > 0)}
        accessibilityLabel={shell ? "Shell command input" : "Message"}
      >
        {shell ? words.slice(1) : segments(words, chips).map(([part, chip], at) => <Text key={at} style={chip && { color: chipTone(chip) }}>{part}</Text>)}
      </TextInput>
      {scrolled ? <View pointerEvents="none" style={[st.fade, { experimental_backgroundImage: `linear-gradient(to bottom, ${under}, transparent)` }]} /> : null}
    </View>
  );
}

/** The field's words cut at each chip, so a chip is drawn as one. */
export function segments(words: string, chips: readonly Named[]): [string, Named | null][] {
  return partsOf(words, chips).map((part) => (typeof part === "string" ? [part, null] : [(part as Named).label, part as Named]));
}


/**
 * A tile's ✕: a dark dot inside its corner. Its reach grows out to the corner, and on a card down and in too; on an
 * image it stops short of the middle, which opens the image.
 */
export const Remove = ({ label, onPress, image }: { label: string; onPress: () => void; image: boolean }) => (
  <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={image ? { top: 6, right: 6, left: 4, bottom: 4 } : 14} style={st.remove}>
    <X className="size-icon-xs text-background" />
  </Pressable>
);

/** A card in the tiles row: an icon in its box, a title over a second line, and its ✕ where it has one. */
export function Card({ icon, title, detail, label = detail, invalid, children }: { icon: React.ReactNode; title: string; detail: React.ReactNode; label?: React.ReactNode; invalid?: boolean; children?: React.ReactNode }) {
  return (
    <View accessible accessibilityLabel={`${title}, ${label}`} style={[st.fileCard, invalid && { borderColor: color.invalid }]}>
      <View style={st.iconBox}>{icon}</View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={st.cardTitle} numberOfLines={1}>{title}</Text>
        <Text style={st.cardDetail} numberOfLines={1}>{detail}</Text>
      </View>
      {children}
    </View>
  );
}

/**
 * A file over the field: an image as a rounded thumbnail, pulsing till Rust has it with a spinner over it; any other
 * as a card with its kind, Attaching… or why it failed, red-edged then. A tap opens an image whole.
 */
export function Tile({ owner, file, onOpen, onRemove }: { owner: string; file: Attachment; onOpen: () => void; onRemove: () => void }) {
  const name = baseName(file.name);
  const image = file.mime.startsWith("image/") && file.state !== "failed";
  const remove = <Remove label={`Remove ${name}`} onPress={onRemove} image={image} />;
  if (image) {
    return (
      <View style={st.thumb}>
        {file.state === "ready" ? (
          <>
            <ThreadImage owner={owner} attachment={file.id} mime={file.mime} label={file.name} style={StyleSheet.absoluteFill} />
            <Pressable accessibilityRole="button" accessibilityLabel={`Preview ${file.name}`} onPress={onOpen} style={StyleSheet.absoluteFill} />
          </>
        ) : (
          <Pulsing />
        )}
        <View pointerEvents="none" style={st.ring} />
        {file.state === "uploading" ? (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, st.centred]}>
            <Spin><Spinner aria-label="Uploading" className="size-icon-md" /></Spin>
          </View>
        ) : null}
        {remove}
      </View>
    );
  }
  const failed = file.state === "failed";
  const Kind = file.mime.startsWith("image/") ? FileImage : file.mime.startsWith("text/") || file.mime === "application/pdf" ? FileDocument : Paperclip;
  const icon = failed ? <Warning aria-label="Upload failed" className="size-icon-md text-destructive" /> : file.state === "uploading" ? <Spin><Spinner aria-label="Uploading" className="size-icon-md" /></Spin> : <Kind className="size-icon-md" />;
  return (
    <Card icon={icon} title={name} detail={failed ? (file.error ?? COMPOSER_WORDS.couldntAttach) : file.state === "uploading" ? COMPOSER_WORDS.attaching : kindOf(file.name, file.mime)} invalid={failed}>
      {remove}
    </Card>
  );
}

/** An image's box till its bytes are in. */
export const Pulsing = () => <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: color.muted, opacity: usePulse() }]} />;

/**
 * What waits above the field for the agent, as the desktop's CommentChip and AgentChipTile: a diff comment, a Resolve or
 * a Fix with agent. A phone only reads them and sends them with its next message, so no ✕ [allow.rs `chips`].
 */
export function ChipTile({ chip }: { chip: PanelChip }) {
  if (chip.kind === "comment") {
    const at = commentAt(chip.comment);
    // The place, then the excerpt in mono, as the desktop's CommentChip.
    const detail = (
      <>
        {at}
        <Text style={{ fontFamily: mono }}>{`  ${chip.comment.excerpt}`}</Text>
      </>
    );
    return <Card icon={<Comment className="size-icon-md" />} title={chip.comment.text} detail={detail} label={`${at} ${chip.comment.excerpt}`} />;
  }
  const words = agentChipWords(chip.chip);
  return <Card icon={chip.chip.kind === "resolve" ? <Sparkles className="size-icon-md" /> : <XCircle className="size-icon-md text-destructive" />} {...words} />;
}

/** An image tile opened whole, as the desktop's viewer; held, it saves to Photos. */
export function Viewer({ owner, file, onClose }: { owner: string; file: Attachment; onClose: () => void }) {
  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <SafeAreaView style={st.viewer}>
        <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12} style={st.done}>
          <Text style={st.doneText}>Done</Text>
        </Pressable>
        <ThreadImage owner={owner} attachment={file.id} mime={file.mime} label={file.name} style={{ flex: 1 }} whole />
      </SafeAreaView>
    </Modal>
  );
}

/** A message on its way, as the desktop's sent.tsx bubbles: sending, or why not with Try again, Discard and Edit. */
export function OnItsWay({ id, entry }: { id: string; entry: Going }) {
  const { run, sends: sending } = forMac();
  const failed = entry.stuck;
  // One that may have reached its agent is only tried again, under its id [C75].
  const maybe = entry.reached !== false;
  return (
    <View style={st.going}>
      <Text style={st.goingText} numberOfLines={3}>{entry.op[2] ?? plainText(entry.draft.parts)}</Text>
      <Text style={failed ? st.error : st.muted}>{failed ? `${maybe ? "May have been sent" : "Not sent"} · ${failed}` : "Sending…"}</Text>
      {failed ? (
        <View style={st.actions}>
          {entry.op.length > 0 ? <Link title="Try again" onPress={() => void sending.again(run, id, entry)} /> : null}
          {!maybe ? <Link title="Edit" onPress={() => sending.discard(run, id, entry, true)} /> : null}
          {!maybe ? <Link title="Discard" onPress={() => sending.discard(run, id, entry)} /> : null}
        </View>
      ) : null}
    </View>
  );
}

export const Link = ({ title, disabled, onPress }: { title: string; disabled?: boolean; onPress: () => void }) => (
  <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} hitSlop={8} style={disabled && { opacity: opacity.disabled }}>
    <Text style={st.link}>{title}</Text>
  </Pressable>
);

/** Overnight's sky behind the card's words, as overnight.css's ::before glow and ::after stars: one layer each. */
export const NightSky = () => (
  <>
    {[night.glow, night.stars].map((layer, at) => (
      <View key={at} pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius.composer, opacity: layer.opacity, experimental_backgroundImage: layer.backgroundImage }]} />
    ))}
  </>
);

export const st = StyleSheet.create({
  // 12 under the card (pb-3), or the home indicator's inset where that's more.
  column: { gap: 8, paddingHorizontal: 16, paddingBottom: 12, backgroundColor: color.background },
  // The gap above the card is taken back, and the tuck under its top edge.
  rail: { marginHorizontal: spacing.railInset, marginBottom: -spacing.railTuck - 8, paddingBottom: spacing.railTuck, borderTopLeftRadius: radius.overlay, borderTopRightRadius: radius.overlay, borderWidth: 1, borderBottomWidth: 0, borderColor: color.border, backgroundColor: color.codeSurface, overflow: "hidden" },
  ruled: { borderTopWidth: 1, borderTopColor: color.border },
  card: { gap: 4, padding: 8, borderRadius: radius.composer, backgroundColor: color.composer, boxShadow: shadow.composer },
  night: night.card,
  shell: { boxShadow: `${shadow.composer}, 0 0 0 1px ${color.link}` },
  input: { ...text.base, color: color.foreground, minHeight: spacing.composer, paddingHorizontal: 8, paddingTop: 10, paddingBottom: 10 },
  mono: { fontFamily: mono, paddingLeft: 36 },
  terminal: { position: "absolute", left: 8, top: 14, zIndex: 1 },
  fade: { position: "absolute", left: 0, right: 0, top: 0, height: 16 },
  footer: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 2 },
  shellWords: { ...text.sm, color: color.link, paddingHorizontal: 8, height: spacing.controlSm, lineHeight: spacing.controlSm, flexShrink: 1 },
  plus: { width: spacing.controlSm, height: spacing.controlSm, borderRadius: radius.iconButton, alignItems: "center", justifyContent: "center" },
  pillText: { ...text.sm, color: color.mutedForeground, flexShrink: 1 },
  end: { flexDirection: "row", alignItems: "center", gap: 2, marginLeft: "auto", flexShrink: 1, minWidth: 0 },
  status: { ...text.xs, color: color.mutedForeground, flexShrink: 1, paddingHorizontal: 4 },
  send: { width: spacing.controlSm, height: spacing.controlSm, borderRadius: spacing.controlSm / 2, backgroundColor: color.primary, alignItems: "center", justifyContent: "center" },
  run: { height: spacing.controlSm, borderRadius: spacing.controlSm / 2, paddingHorizontal: 12, backgroundColor: color.primary, alignItems: "center", justifyContent: "center" },
  runText: { ...text.sm, fontWeight: "500", color: color.primaryFg },
  waits: { ...text.xs, color: color.mutedForeground, paddingHorizontal: 8, marginTop: -4 },
  tiles: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", gap: 8, paddingHorizontal: 4, paddingTop: 4, paddingBottom: 6 },
  thumb: { width: spacing.attachmentThumb, height: spacing.attachmentThumb, borderRadius: radius.surface, overflow: "hidden", backgroundColor: color.muted },
  ring: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: radius.surface, borderWidth: 1, borderColor: color.border },
  centred: { alignItems: "center", justifyContent: "center" },
  fileCard: { width: spacing.attachmentCard, maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: 8, padding: 6, paddingRight: 28, borderRadius: radius.surface, borderWidth: 1, borderColor: color.border },
  iconBox: { width: spacing.controlLg, height: spacing.controlLg, borderRadius: radius.iconButton, backgroundColor: color.background, alignItems: "center", justifyContent: "center" },
  cardTitle: { ...text.sm, color: color.foreground },
  cardDetail: { ...text.xs, color: color.mutedForeground },
  remove: { position: "absolute", top: 6, right: 6, width: spacing.iconMd, height: spacing.iconMd, borderRadius: spacing.iconMd / 2, backgroundColor: color.foreground, alignItems: "center", justifyContent: "center", zIndex: 1 },
  viewer: { flex: 1, backgroundColor: color.imageViewer },
  done: { alignSelf: "flex-end", padding: 16 },
  doneText: { ...text.base, fontWeight: "600", color: color.primary },
  going: { alignSelf: "flex-end", maxWidth: "85%", gap: 4, borderRadius: 16, backgroundColor: color.bubble, padding: 12 },
  goingText: { ...text.base, color: color.chatForeground },
  actions: { flexDirection: "row", gap: 16 },
  link: { ...text.sm, color: color.link },
  muted: { ...text.sm, color: color.mutedForeground },
  error: { ...text.sm, color: color.destructive },
});
