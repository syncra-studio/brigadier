// The queue on the composer's rail, as the desktop's composer/queue.tsx: what waits for the running turn, one row each
// in sending order (its glyph, its words, Steer, Delete and ⋯ with Edit, and Move up and Move down in place of the
// drag), the list scrolling past 30% of the screen; over them, each `!` command they wait for, with Run in background.
import { useState } from "react";
import { ActionSheetIOS, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import type { Draft } from "../../../app/shared/draft";
import type { QueuedMessage } from "../../../app/shared/session/queued";
import { color, spacing, radius, text, opacity, mono } from "../theme";
import { ArrowCurvedRight, DotsHorizontal, Play, QueueGlyph, Spinner, Trash } from "../../../app/ui/src/icons";
import { Terminal } from "../../../app/ui/src/icons/thread";
import { FadeIn, Shimmer, Spin } from "./motion";

/** The row's words: the text with each mention's and command's name in place. */
const preview = (draft: Draft) =>
  draft.parts
    .map((part) => (typeof part === "string" ? part : part.kind === "mention" || part.kind === "command" ? part.label : ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();

const plural = (count: number, one: string, many: string) => (count === 1 ? one : `${count} ${many}`);

/** What rides with the text: "Image attachment", "Pasted text", "3 images", "2 files"… or nothing. */
function attached(draft: Draft): string | null {
  const chips = draft.parts.filter((part) => typeof part !== "string" && (part.kind === "image" || part.kind === "paste"));
  const images = chips.filter((chip) => typeof chip !== "string" && chip.kind === "image").length;
  const total = chips.length + draft.attachmentIds.length;
  if (total === 0) return null;
  if (images === total) return plural(total, "Image attachment", "images");
  if (total === 1 && chips.length === 1) return "Pasted text";
  return plural(total, "1 file", "files");
}

/** A message with files, or a file or folder mention (a Mac path the phone may not send): not pulled back to edit here. */
const hasFiles = (draft: Draft) =>
  draft.attachmentIds.length > 0 || draft.parts.some((part) => typeof part !== "string" && (part.kind === "image" || part.kind === "paste" || (part.kind === "mention" && (part.type === "file" || part.type === "folder"))));

export function QueueCard({ items, running, paused, resuming, steer, canEdit, error, onResume, onBackground, onSteer, onRemove, onEdit, onAddAgain, onToSession, onMove, pulled }: {
  items: readonly QueuedMessage[];
  /** The `!` commands running now that what's queued waits for: their ids and lines. */
  running: readonly { id: string; line: string }[];
  paused: boolean;
  /** Resume was asked and hasn't settled: its button waits. */
  resuming: boolean;
  /** The agent can steer the running turn. */
  steer: boolean;
  /** Edit pulls a message back into the field, so only into an empty one. */
  canEdit: boolean;
  error: string | null;
  /** None in a worker's own tab, whose Resume is the worker's [D293]. */
  onResume?: () => void;
  onBackground: (command: { id: string; line: string }) => void;
  onSteer: (id: string) => void;
  onRemove: (id: string) => void;
  onEdit: (id: string) => void;
  onAddAgain: (id: string) => void;
  /** A message for a worker that ended goes to the session instead [D96]. */
  onToSession: (id: string) => void;
  /** Settles when Rust has the move. */
  onMove: (id: string, to: number) => Promise<void>;
  /** A message pulled back to edit that isn't this phone's: Put back returns it to its place. */
  pulled?: { text: string; onPutBack: () => void } | null;
}) {
  // The order the user made, held by id until every move has settled, so Rust's order never undoes one in flight.
  const [held, setHeld] = useState<{ order: readonly string[]; moving: number } | null>(null);
  const rank = new Map(held?.order.map((id, at) => [id, at]));
  const shown = held ? [...items].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)) : items;
  const move = (id: string, to: number) => {
    const order = shown.filter((each) => each.id !== id).map((each) => each.id);
    order.splice(to, 0, id);
    setHeld((now) => ({ order, moving: (now?.moving ?? 0) + 1 }));
    void onMove(id, to)
      .catch(() => {}) // the failure comes back as `error`
      .finally(() => setHeld((now) => (now && now.moving > 1 ? { ...now, moving: now.moving - 1 } : null)));
  };
  const { height } = useWindowDimensions();
  if (items.length === 0 && running.length === 0 && !pulled) return null;
  return (
    <View accessibilityLabel="Message queue">
      {paused ? (
        <View style={st.line}>
          <View style={st.dot} />
          <Text style={st.muted} numberOfLines={1}>Queue paused because you interrupted</Text>
          {onResume ? <Small title="Resume" icon={Play} disabled={resuming} onPress={onResume} /> : null}
        </View>
      ) : null}
      {running.map((command) => (
        <View key={command.id} style={st.line}>
          <Text style={[st.words, { fontFamily: mono }]} numberOfLines={1}>
            <Text style={st.faded}>Running </Text>
            {command.line}
          </Text>
          <Small title="Run in background" disabled={resuming} onPress={() => onBackground(command)} />
        </View>
      ))}
      {pulled ? (
        <View style={st.line}>
          <Text style={st.words} numberOfLines={1}>{pulled.text.replace(/\s+/g, " ").trim()}</Text>
          <Text style={st.note} numberOfLines={1}>Being edited</Text>
          <Small title="Put back" disabled={resuming} onPress={pulled.onPutBack} />
        </View>
      ) : null}
      <ScrollView style={{ maxHeight: height * 0.3, flexGrow: 0 }} contentContainerStyle={{ padding: 4 }} accessibilityLabel="Queued messages">
        {shown.map((item, index) => {
          const local = item.state === "local";
          const unadded = item.state === "unadded";
          const lost = unadded || item.state === "uncertain";
          const deciding = item.state === "deciding";
          const movable = items.length > 1 && !local && !lost;
          const editable = lost || (canEdit && !local && item.state !== "delivered" && !item.peer && !item.shell && !item.to && !hasFiles(item.draft));
          const more = () => {
            const actions = [
              { title: "Edit", go: () => onEdit(item.id), off: !editable },
              ...(item.to?.ended ? [{ title: "Send to the session instead", go: () => onToSession(item.id), off: false }] : []),
              ...(movable && index > 0 ? [{ title: "Move up", go: () => move(item.id, index - 1), off: false }] : []),
              ...(movable && index < shown.length - 1 ? [{ title: "Move down", go: () => move(item.id, index + 1), off: false }] : []),
            ];
            ActionSheetIOS.showActionSheetWithOptions(
              { options: [...actions.map((each) => each.title), "Cancel"], cancelButtonIndex: actions.length, disabledButtonIndices: actions.flatMap((each, at) => (each.off ? [at] : [])) },
              (at) => !actions[at]?.off && actions[at]?.go(),
            );
          };
          const words = preview(item.draft);
          const files = attached(item.draft);
          return (
            <FadeIn key={item.id}>
              <View style={st.row} accessibilityState={{ busy: deciding }}>
                <View style={st.glyph}>{deciding ? <Spin><Spinner className="size-icon-sm text-queue-glyph" /></Spin> : item.shell ? <Terminal aria-label="Shell command" className="size-icon-sm text-queue-glyph" /> : <QueueGlyph className="size-icon-sm text-queue-glyph" />}</View>
                <Text style={[st.words, item.shell && { fontFamily: mono, fontSize: 13 }]} numberOfLines={1}>
                  {words ? (
                    <>
                      {words}
                      {files ? <Text style={st.faded}> · {files}</Text> : null}
                    </>
                  ) : (
                    <Text style={st.faded}>{files}</Text>
                  )}
                </Text>
                {item.peer ? <Text style={st.note} numberOfLines={1}>From {item.peer.title ?? "another session"}</Text> : null}
                {lost ? (
                  <Text style={st.note} numberOfLines={1}>{unadded ? "Not added" : "May not have been added"}</Text>
                ) : deciding ? (
                  <Shimmer style={st.note}>Deciding</Shimmer>
                ) : item.waits ? (
                  <Text style={st.note} numberOfLines={1}>{item.waits}</Text>
                ) : item.to ? (
                  <Text style={st.note} numberOfLines={1}>To {item.to.name ?? "a worker"}</Text>
                ) : null}
                {lost ? <Small title="Add again" onPress={() => onAddAgain(item.id)} /> : null}
                {/* One for a worker steers into that worker's turn, while it has one. */}
                {(steer || item.to) && !item.to?.ended && !item.shell && !lost ? <Small title="Steer" icon={ArrowCurvedRight} accessibilityLabel="Steer: submit without interrupting the model" disabled={local} onPress={() => onSteer(item.id)} /> : null}
                <Icon accessibilityLabel={item.shell ? "Delete queued command" : "Delete queued message"} disabled={local || (item.state === "delivered" && !item.refused)} onPress={() => onRemove(item.id)}>
                  <Trash className="size-icon-sm text-muted-foreground" />
                </Icon>
                <Icon accessibilityLabel="Queued message actions" onPress={more}>
                  <DotsHorizontal className="size-icon-sm text-muted-foreground" />
                </Icon>
              </View>
            </FadeIn>
          );
        })}
      </ScrollView>
      {error ? <Text style={st.error}>{error}</Text> : null}
    </View>
  );
}

/** A ghost button with words, its icon first where it has one. */
function Small({ title, icon: Icon, accessibilityLabel, disabled, onPress }: { title: string; icon?: typeof Play; accessibilityLabel?: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} hitSlop={10} style={({ pressed }) => [st.small, pressed && { backgroundColor: color.fill }, disabled && { opacity: opacity.disabled }]}>
      {Icon ? <Icon className="size-icon-sm text-muted-foreground" /> : null}
      <Text style={st.smallText}>{title}</Text>
    </Pressable>
  );
}

/** A ghost icon button, 28 across with a finger's reach. */
function Icon({ accessibilityLabel, disabled, onPress, children }: { accessibilityLabel: string; disabled?: boolean; onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} hitSlop={8} style={({ pressed }) => [st.icon, pressed && { backgroundColor: color.fill }, disabled && { opacity: opacity.disabled }]}>
      {children}
    </Pressable>
  );
}

const st = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: spacing.controlMd, paddingHorizontal: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: spacing.controlMd, paddingLeft: 6, paddingRight: 4, borderRadius: radius.control },
  glyph: { width: spacing.controlXs, height: spacing.controlXs, alignItems: "center", justifyContent: "center" },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.warning },
  words: { ...text.sm, color: color.foreground, flex: 1 },
  muted: { ...text.sm, color: color.mutedForeground, flex: 1 },
  faded: { color: color.mutedForeground },
  note: { ...text.xs, color: color.mutedForeground, flexShrink: 1, maxWidth: 140 },
  small: { flexDirection: "row", alignItems: "center", gap: 4, height: spacing.controlXs, paddingHorizontal: 8, borderRadius: radius.control },
  smallText: { ...text.label, color: color.mutedForeground },
  icon: { width: spacing.controlSm, height: spacing.controlSm, alignItems: "center", justifyContent: "center", borderRadius: radius.iconButton },
  error: { ...text.xs, color: color.destructive, paddingHorizontal: 12, paddingBottom: 4 },
});
