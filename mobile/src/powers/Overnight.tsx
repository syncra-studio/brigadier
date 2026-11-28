// Overnight, as the desktop's sessions/overnight.ts and overnight-parts.tsx: its pill after the level pill, behind a
// divider; on the rail in the night how far it is, with I'm back; once all it needs is answered, "Before you go" with
// Start night, which also waits under the turn's last questions. Each act is signed (power `overnight`) and shown at
// once once the Mac takes it, till the row has it [D30].
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Overnight, Row } from "../../../app/shared/rows";
import { duration } from "../../../app/shared/words";
import { type NightAct as Act, nightActs as taken, NIGHT_WORDS as N, nightProgress, nightShown, putNightAct as put } from "../../../app/shared/session/composer";
import { Confirm } from "../act/Confirm";
import { Moon } from "../../../app/ui/src/icons";
import { Pill, PillDivider } from "../compose/Pill";
import { newId } from "../compose/state";
import { color, fontWeight, opacity, radius, space, spacing, text, touch } from "../theme";
import { type Power, refusal } from "./powers";

/** Each act's sheet words; `night`, the user is back from one. */
export const nightWords = (act: Act, night: boolean): { title: string; body?: string } =>
  act === "on"
    ? { title: "Turn Overnight on?", body: "It asks what it needs, then finishes the job while you’re away." }
    : act === "start"
      ? { title: "Start night?", body: "This Mac stays awake. It picks what you skip and tells you in the morning." }
      : { title: night ? "I’m back: end the night?" : "Turn Overnight off?" };

/** What the session's overnight is, null off: the last act taken until the row has it. */
function useOvernight(id: string, row: Row | undefined): Overnight | null {
  const mine = useSyncExternalStore(taken.subscribe, () => taken.get().get(id));
  const landed = mine !== undefined && row?.overnight_op === mine.op;
  useEffect(() => {
    if (landed) put(id, null);
  }, [landed, id]);
  return nightShown(row?.overnight ?? null, mine, landed);
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
      <Pill label={N.pill} selected={on} disabled={!connected} onPress={() => night.ask(on ? "off" : "on")} style={on && { backgroundColor: color.pickedRow }}>
        <Moon className="size-icon-md" color={on ? color.tileViolet : color.mutedForeground} />
        <Text style={[st.pillText, on && { color: color.tileViolet }]} numberOfLines={1}>{N.pill}</Text>
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
    <View style={st.strip} accessibilityLabel={N.pill}>
      <Moon className="size-icon-md text-tile-violet" />
      <Text style={st.words} numberOfLines={1}>
        {now.since ? `${duration(tick - now.since)} in` : N.pill}
        <Text style={st.muted}>{nightProgress(now)}</Text>
      </Text>
      <Pressable accessibilityRole="button" disabled={!connected} onPress={() => night.ask("off")} hitSlop={(touch - spacing.controlXs) / 2} style={({ pressed }) => [st.soft, pressed && { backgroundColor: color.fillHover }, !connected && { opacity: opacity.disabled }]}>
        <Text style={st.softText}>{N.imBack}</Text>
      </Pressable>
    </View>
  );
}

/** Start night, after what it says before the user goes. */
export function StartNight({ label, night, connected }: { label: string; night: Night; connected: boolean }) {
  return (
    <View style={st.actions}>
      <Text style={st.label}>{label}</Text>
      <Pressable accessibilityRole="button" disabled={!connected} onPress={() => night.ask("start")} hitSlop={(touch - spacing.controlSm) / 2} style={({ pressed }) => [st.primary, pressed && { backgroundColor: color.primaryHover }, !connected && { opacity: opacity.disabled }]}>
        <Moon className="size-icon-md text-primary-fg" />
        <Text style={st.primaryText}>{N.start}</Text>
      </Pressable>
    </View>
  );
}

/** "Before you go": all it needs is answered, what it does alone, and Start night. */
export function NightReady({ night, connected }: { night: Night; connected: boolean }) {
  if (night.now?.state !== "ready") return null;
  return (
    <View accessibilityLabel={N.beforeYouGo}>
      <View style={st.ready}>
        <Text style={st.readyTitle}>{N.ready}</Text>
        {night.now.words ? <Text style={st.readyWords}>{night.now.words}</Text> : null}
      </View>
      <StartNight label={N.awake} night={night} connected={connected} />
    </View>
  );
}

// The strip's px-3.5 py-2 row; Start night in an ActionCardActions row (gap-2 px-4 pt-2 pb-4); I'm back the desktop's
// Button xs soft, Start night its sm default; the ready card's words px-4 pt-4 gap-1.
const st = StyleSheet.create({
  pillText: { ...text.sm, color: color.mutedForeground, flexShrink: 1 },
  strip: { flexDirection: "row", alignItems: "center", gap: space(2), paddingHorizontal: space(3.5), paddingVertical: space(2) },
  words: { ...text.sm, color: color.foreground, flex: 1 },
  muted: { color: color.mutedForeground },
  label: { ...text.xs, color: color.mutedForeground, flex: 1 },
  soft: { flexDirection: "row", alignItems: "center", gap: space(1), height: spacing.controlXs, paddingHorizontal: space(2), borderRadius: radius.capsule, backgroundColor: color.fillSubtle },
  softText: { ...text.xs, fontWeight: fontWeight.normal, color: color.foreground },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space(2), paddingHorizontal: space(4), paddingTop: space(2), paddingBottom: space(4) },
  primary: { flexDirection: "row", alignItems: "center", gap: space(1), height: spacing.controlSm, paddingHorizontal: space(2.5), borderRadius: radius.capsule, backgroundColor: color.primary },
  primaryText: { ...text.sm, fontWeight: fontWeight.medium, color: color.primaryFg },
  ready: { gap: space(1), paddingHorizontal: space(4), paddingTop: space(4) },
  readyTitle: { ...text.sm, fontWeight: fontWeight.medium, color: color.foreground },
  readyWords: { ...text.label, color: color.mutedForeground },
});
