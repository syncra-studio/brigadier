// The queue card over the field, as the desktop's composer/queue.tsx: what waits for the running turn, one row each in
// sending order, with Steer, Delete and ⋯ (Edit, Move up, Move down in place of the drag).
import { useState } from "react";
import { ActionSheetIOS, Pressable, StyleSheet, Text, View } from "react-native";
import type { Draft } from "../../vendor/brigadier-shared/draft";
import type { QueuedMessage } from "../../vendor/brigadier-shared/session/queued";
import { color, text } from "../theme";

/** The row's words: the text with each mention's and command's name in place. */
const preview = (draft: Draft) =>
  draft.parts
    .map((part) => (typeof part === "string" ? part : part.kind === "mention" || part.kind === "command" ? part.label : ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();

/** A message with files: the phone can't carry them, so it isn't pulled back to edit here. */
const hasFiles = (draft: Draft) => draft.attachmentIds.length > 0 || draft.parts.some((part) => typeof part !== "string" && (part.kind === "image" || part.kind === "paste"));

export function QueueCard({ items, paused, resuming, steer, canEdit, error, onResume, onSteer, onRemove, onEdit, onAddAgain, onMove }: {
  items: readonly QueuedMessage[];
  paused: boolean;
  /** Resume was asked and hasn't settled: its button waits. */
  resuming: boolean;
  /** The agent can steer the running turn. */
  steer: boolean;
  /** Edit pulls a message back into the field, so only into an empty one. */
  canEdit: boolean;
  error: string | null;
  onResume: () => void;
  onSteer: (id: string) => void;
  onRemove: (id: string) => void;
  onEdit: (id: string) => void;
  onAddAgain: (id: string) => void;
  /** Settles when Rust has the move. */
  onMove: (id: string, to: number) => Promise<void>;
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
  if (items.length === 0) return null;
  return (
    <View style={st.card} accessibilityLabel="Message queue">
      {paused ? (
        <View style={st.row}>
          <View style={st.dot} />
          <Text style={st.words} numberOfLines={1}>Queue paused because you interrupted</Text>
          <Small title="Resume" disabled={resuming} onPress={onResume} />
        </View>
      ) : null}
      {shown.map((item, index) => {
        const local = item.state === "local";
        const unadded = item.state === "unadded";
        const lost = unadded || item.state === "uncertain";
        const movable = items.length > 1 && !local && !lost;
        const editable = lost || (canEdit && !local && item.state !== "delivered" && !item.peer && !item.shell && !item.to && !hasFiles(item.draft));
        const more = () => {
          const actions = [
            ...(editable ? [{ title: "Edit", go: () => onEdit(item.id) }] : []),
            ...(movable && index > 0 ? [{ title: "Move up", go: () => move(item.id, index - 1) }] : []),
            ...(movable && index < shown.length - 1 ? [{ title: "Move down", go: () => move(item.id, index + 1) }] : []),
          ];
          ActionSheetIOS.showActionSheetWithOptions({ options: [...actions.map((each) => each.title), "Cancel"], cancelButtonIndex: actions.length }, (at) => actions[at]?.go());
        };
        const words = preview(item.draft);
        const note = lost ? (unadded ? "Not added" : "May not have been added") : item.state === "deciding" ? "Deciding" : (item.waits ?? (item.to ? `To ${item.to.name ?? "a worker"}` : null));
        return (
          <View key={item.id} style={st.row}>
            <Text style={[st.words, item.shell && { fontFamily: "Menlo" }]} numberOfLines={1}>
              {item.shell ? "! " : ""}
              {words || <Text style={st.muted}>{item.draft.attachmentIds.length ? "Files" : ""}</Text>}
              {item.peer ? <Text style={st.muted}> · from {item.peer.title ?? "a session"}</Text> : null}
            </Text>
            {note ? <Text style={st.note} numberOfLines={1}>{note}</Text> : null}
            {lost ? <Small title="Add again" onPress={() => onAddAgain(item.id)} /> : null}
            {steer && !item.to && !item.shell && !lost ? <Small title="Steer" disabled={local} onPress={() => onSteer(item.id)} /> : null}
            <Small title="Delete" accessibilityLabel={item.shell ? "Delete queued command" : "Delete queued message"} disabled={local || (item.state === "delivered" && !item.refused)} onPress={() => onRemove(item.id)} />
            {editable || movable ? <Small title="⋯" accessibilityLabel="Queued message actions" onPress={more} /> : null}
          </View>
        );
      })}
      {error ? <Text style={st.error}>{error}</Text> : null}
    </View>
  );
}

function Small({ title, accessibilityLabel, disabled, onPress }: { title: string; accessibilityLabel?: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} hitSlop={6} style={({ pressed }) => [st.small, (pressed || disabled) && { opacity: disabled ? 0.4 : 0.7 }]}>
      <Text style={st.smallText}>{title}</Text>
    </Pressable>
  );
}

const st = StyleSheet.create({
  card: { borderRadius: 16, backgroundColor: color.muted, paddingVertical: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 40, paddingHorizontal: 12 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.warning },
  words: { ...text.sm, color: color.foreground, flex: 1 },
  muted: { color: color.mutedForeground },
  note: { fontSize: 12, color: color.mutedForeground, flexShrink: 0, maxWidth: 140 },
  small: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999 },
  smallText: { ...text.sm, color: color.mutedForeground },
  error: { ...text.sm, color: color.destructive, paddingHorizontal: 12, paddingBottom: 8 },
});
