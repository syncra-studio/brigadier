// Overnight, as the desktop's sessions/overnight.ts and overnight-parts.tsx: its pill after the level pill, behind a
// divider; on the rail in the night how far it is, with I'm back; once all it needs is answered, "Before you go" with
// Start night, which also waits under the turn's last questions. Each act is signed (power `overnight`) and shown at
// once once the Mac takes it, till the row has it [D30].
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Overnight, Row } from "../../../app/shared/rows";
import { store } from "../../../app/shared/store";
import { duration } from "../../../app/shared/words";
import { Confirm } from "../act/Confirm";
import { Glyph } from "../compose/Glyph";
import { Pill, PillDivider } from "../compose/Pill";
import { newId } from "../compose/state";
import { color, size, text } from "../theme";
import { type Power, refusal } from "./powers";

type Act = "on" | "start" | "off";

/** Each act's sheet words; `night`, the user is back from one. */
export const nightWords = (act: Act, night: boolean): { title: string; body?: string } =>
  act === "on"
    ? { title: "Turn Overnight on?", body: "It asks what it needs, then finishes the job while you’re away." }
    : act === "start"
      ? { title: "Start night?", body: "This Mac stays awake. It picks what you skip and tells you in the morning." }
      : { title: night ? "I’m back: end the night?" : "Turn Overnight off?" };

/** The field's words while Overnight is on; `asked`: its turn's questions are there already, waiting or answered. */
export const nightPlaceholder = (now: Overnight | null, busy: boolean, asked: boolean) =>
  now === null ? undefined : now.state === "night" ? "Working until you’re back" : now.state === "asking" && busy && !asked ? "It asks its last questions next" : "Anything else before you go?";

/** Each session's last act the Mac took, by its op id, till the row's `overnight_op` reaches it. */
const taken = store<ReadonlyMap<string, { op: string; act: Act; at: number }>>(new Map());
function put(id: string, entry: { op: string; act: Act; at: number } | null) {
  const next = new Map(taken.get());
  if (entry) next.set(id, entry);
  else next.delete(id);
  taken.set(next);
}

/** What the session's overnight is, null off: the last act taken until the row has it. */
function useOvernight(id: string, row: Row | undefined): Overnight | null {
  const mine = useSyncExternalStore(taken.subscribe, () => taken.get().get(id));
  const landed = mine !== undefined && row?.overnight_op === mine.op;
  useEffect(() => {
    if (landed) put(id, null);
  }, [landed, id]);
  const now = row?.overnight ?? null;
  if (!mine || landed) return now;
  if (mine.act === "off") return null;
  if (mine.act === "start") return { ...now, state: "night", since: mine.at };
  return { ...now, state: "asking" };
}

/**
 * The session's overnight (null off, or for a worker), `ask` for an act's Face ID sheet, the sheet itself and its
 * refusal in the Mac's words. One per composer, so the pill, the rail and /overnight share one sheet.
 */
export function useNight(id: string, row: Row | undefined) {
  const now = useOvernight(id, row?.worker ? undefined : row);
  const [asking, setAsking] = useState<(Power & { act: Act; op: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ask = (act: Act) => {
    setError(null);
    const op = newId();
    setAsking({ ...nightWords(act, now?.state === "night"), shown: row?.title || "New session", act, op, args: ["overnight", id, act, "--op", op] });
  };
  // The sheet stays whatever the rail shows: turned off meanwhile (maybe from the Mac), a signature under way goes on.
  const sheet = asking ? (
    <Confirm
      title={asking.title}
      body={asking.body}
      shown={asking.shown}
      args={asking.args}
      onDone={(reply) => {
        setAsking(null);
        if (!reply) return;
        if (reply.ok) put(id, { op: asking.op, act: asking.act, at: Date.now() });
        else setError(refusal(reply));
      }}
    />
  ) : null;
  return { now, ask, sheet, error };
}
export type Night = ReturnType<typeof useNight>;

/** The Overnight pill: on, it turns it off, or in the night the user is back. */
export function OvernightPill({ night, connected }: { night: Night; connected: boolean }) {
  const on = night.now !== null;
  return (
    <>
      <PillDivider />
      <Pill label="Overnight" selected={on} disabled={!connected} onPress={() => night.ask(on ? "off" : "on")} style={on && { backgroundColor: color.pickedRow }}>
        <Glyph name="moon" color={on ? color.violet : color.mutedForeground} />
        <Text style={[st.pillText, on && { color: color.violet }]} numberOfLines={1}>Overnight</Text>
      </Pill>
    </>
  );
}

/** On the rail in the night: how long, how far, and the way back. */
export function OvernightStrip({ night, connected }: { night: Night; connected: boolean }) {
  const now = night.now?.state === "night" ? night.now : null;
  const [tick, setTick] = useState(Date.now);
  useEffect(() => {
    if (!now) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [now !== null]);
  if (!now) return null;
  return (
    <View style={st.strip} accessibilityLabel="Overnight">
      <Glyph name="moon" color={color.violet} />
      <Text style={st.words} numberOfLines={1}>
        {now.since ? `${duration(tick - now.since)} in` : "Overnight"}
        <Text style={st.muted}>
          {now.total ? ` · ${now.done ?? 0} of ${now.total} parts done` : ""}
          {now.decided ? ` · ${now.decided} decided for you` : ""}
        </Text>
      </Text>
      <Pressable accessibilityRole="button" disabled={!connected} onPress={() => night.ask("off")} hitSlop={10} style={({ pressed }) => [st.soft, (pressed || !connected) && { opacity: connected ? 0.7 : size.disabled }]}>
        <Text style={st.softText}>I’m back</Text>
      </Pressable>
    </View>
  );
}

/** Start night, after what it says before the user goes. */
export function StartNight({ label, night, connected }: { label: string; night: Night; connected: boolean }) {
  return (
    <View style={st.actions}>
      <Text style={st.label}>{label}</Text>
      <Pressable accessibilityRole="button" disabled={!connected} onPress={() => night.ask("start")} hitSlop={6} style={({ pressed }) => [st.primary, (pressed || !connected) && { opacity: connected ? 0.8 : size.disabled }]}>
        <Glyph name="moon" size={size.iconSm} color={color.primaryFg} />
        <Text style={st.primaryText}>Start night</Text>
      </Pressable>
    </View>
  );
}

/** "Before you go": all it needs is answered, what it does alone, and Start night. */
export function NightReady({ night, connected }: { night: Night; connected: boolean }) {
  if (night.now?.state !== "ready") return null;
  return (
    <View accessibilityLabel="Before you go">
      <View style={{ gap: 4, paddingHorizontal: 16, paddingTop: 16 }}>
        <Text style={[st.words, { fontWeight: "500" }]}>That’s all I need</Text>
        {night.now.words ? <Text style={[st.label, { flex: 0 }]}>{night.now.words}</Text> : null}
      </View>
      <StartNight label="This Mac stays awake" night={night} connected={connected} />
    </View>
  );
}

const st = StyleSheet.create({
  pillText: { ...text.sm, color: color.mutedForeground, flexShrink: 1 },
  strip: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 8 },
  words: { ...text.sm, color: color.foreground, flex: 1 },
  muted: { color: color.mutedForeground },
  label: { ...text.xs, color: color.mutedForeground, flex: 1 },
  soft: { height: size.controlXs, justifyContent: "center", paddingHorizontal: 8, borderRadius: size.radiusControl, backgroundColor: color.fill },
  softText: { ...text.label, color: color.foreground },
  actions: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  primary: { flexDirection: "row", alignItems: "center", gap: 6, height: size.controlSm + 4, paddingHorizontal: 12, borderRadius: size.radiusControl, backgroundColor: color.primary },
  primaryText: { ...text.sm, fontWeight: "500", color: color.primaryFg },
});
