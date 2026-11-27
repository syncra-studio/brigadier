// Overnight, as the desktop's sessions/overnight.ts and overnight-parts.tsx: its pill beside the level pill, and over
// the field what the night needs (Start night) or, in it, how far it is with I'm back. Each act is signed (power
// `overnight`) and shown at once once the Mac takes it, till the row has it [D30].
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Overnight, Row } from "../../vendor/brigadier-shared/rows";
import { store } from "../../vendor/brigadier-shared/store";
import { duration } from "../../vendor/brigadier-shared/words";
import { Confirm } from "../act/Confirm";
import { newId } from "../compose/state";
import { color, text } from "../theme";
import { type Power, refusal } from "./powers";

type Act = "on" | "start" | "off";
type Props = { id: string; row: Row; connected: boolean };

/** Each act's sheet words; `night`, the user is back from one. */
export const nightWords = (act: Act, night: boolean): { title: string; body?: string } =>
  act === "on"
    ? { title: "Turn Overnight on?", body: "It asks what it needs, then finishes the job while you’re away." }
    : act === "start"
      ? { title: "Start night?", body: "This Mac stays awake. It picks what you skip and tells you in the morning." }
      : { title: night ? "I’m back: end the night?" : "Turn Overnight off?" };

/** Each session's last act the Mac took, by its op id, till the row's `overnight_op` reaches it. */
const taken = store<ReadonlyMap<string, { op: string; act: Act; at: number }>>(new Map());
function put(id: string, entry: { op: string; act: Act; at: number } | null) {
  const next = new Map(taken.get());
  if (entry) next.set(id, entry);
  else next.delete(id);
  taken.set(next);
}

/** What the session's overnight is, null off: the last act taken until the row has it. */
function useOvernight(id: string, row: Row): Overnight | null {
  const mine = useSyncExternalStore(taken.subscribe, () => taken.get().get(id));
  const landed = mine !== undefined && row.overnight_op === mine.op;
  useEffect(() => {
    if (landed) put(id, null);
  }, [landed, id]);
  const now = row.overnight ?? null;
  if (!mine || landed) return now;
  if (mine.act === "off") return null;
  if (mine.act === "start") return { ...now, state: "night", since: mine.at };
  return { ...now, state: "asking" };
}

/** The Face ID sheet for an act, and its refusal in the Mac's words. */
function useAct(id: string, row: Row) {
  const [asking, setAsking] = useState<(Power & { act: Act; op: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = row.title || "New session";
  const ask = (act: Act, night: boolean) => {
    setError(null);
    const op = newId();
    setAsking({ ...nightWords(act, night), shown, act, op, args: ["overnight", id, act, "--op", op] });
  };
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
  return { ask, sheet, error };
}

/** The Overnight pill: on, it turns it off, or in the night the user is back. */
export function OvernightPill({ id, row, connected }: Props) {
  const now = useOvernight(id, row);
  const { ask, sheet, error } = useAct(id, row);
  const on = now !== null;
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel="Overnight" accessibilityState={{ selected: on }} disabled={!connected} onPress={() => ask(on ? "off" : "on", now?.state === "night")} style={({ pressed }) => [st.pill, on && st.on, (pressed || !connected) && { opacity: 0.6 }]}>
        <Text style={st.pillText} numberOfLines={1}>☾ Overnight</Text>
      </Pressable>
      {error ? <Text style={st.error} numberOfLines={2}>{error}</Text> : null}
      {sheet}
    </>
  );
}

/** Over the field while Overnight is on: Start night once it can go, and in the night how far it is, with I'm back. */
export function OvernightStrip({ id, row, connected }: Props) {
  const now = useOvernight(id, row);
  const { ask, sheet, error } = useAct(id, row);
  const night = now?.state === "night" ? now : null;
  const [tick, setTick] = useState(Date.now);
  useEffect(() => {
    if (!night) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [night !== null]);
  // The sheet stays in one place whatever the strip shows: turned off meanwhile (maybe from the Mac), a signature under
  // way goes on, and its refusal shows.
  return (
    <>
      {now ? (
        <View style={st.strip} accessibilityLabel="Overnight">
          {night ? (
            <View style={st.line}>
              <Text style={st.words} numberOfLines={1}>
                ☾ {night.since ? `${duration(tick - night.since)} in` : "Overnight"}
                <Text style={st.muted}>
                  {night.total ? ` · ${night.done ?? 0} of ${night.total} parts done` : ""}
                  {night.decided ? ` · ${night.decided} decided for you` : ""}
                </Text>
              </Text>
              <Small title="I’m back" disabled={!connected} onPress={() => ask("off", true)} />
            </View>
          ) : (
            <>
              {now.state === "ready" ? <Text style={st.words}>That’s all I need</Text> : null}
              {now.state === "ready" && now.words ? <Text style={st.muted}>{now.words}</Text> : null}
              <View style={st.line}>
                <Text style={[st.muted, { flex: 1 }]}>{now.state === "ready" ? "This Mac stays awake" : "Or start now: it picks what you skip and tells you in the morning"}</Text>
                <Small title="Start night" disabled={!connected} onPress={() => ask("start", false)} />
              </View>
            </>
          )}
          {error ? <Text style={st.error}>{error}</Text> : null}
        </View>
      ) : error ? (
        <Text style={st.error}>{error}</Text>
      ) : null}
      {sheet}
    </>
  );
}

function Small({ title, disabled, onPress }: { title: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} hitSlop={6} style={({ pressed }) => [st.small, (pressed || disabled) && { opacity: disabled ? 0.4 : 0.7 }]}>
      <Text style={st.smallText}>{title}</Text>
    </Pressable>
  );
}

const st = StyleSheet.create({
  pill: { borderRadius: 999, backgroundColor: color.fill, paddingHorizontal: 12, paddingVertical: 6 },
  on: { backgroundColor: color.muted },
  pillText: { ...text.sm, color: color.foreground },
  strip: { borderRadius: 16, backgroundColor: color.muted, paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  line: { flexDirection: "row", alignItems: "center", gap: 8 },
  words: { ...text.sm, color: color.foreground, flex: 1 },
  muted: { ...text.sm, color: color.mutedForeground },
  small: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: color.fill },
  smallText: { ...text.sm, color: color.foreground },
  error: { ...text.sm, color: color.destructive, flexShrink: 1 },
});
