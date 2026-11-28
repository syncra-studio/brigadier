// The session's permission pill, as the desktop's session/level.tsx and composer/pickers.tsx: its icon and label,
// orange on Full access; a sheet asking how the agent's actions should be approved, each level with its icon and line
// and a check on the one in use, Ask alone where the folder isn't trusted. Each change is signed with Face ID (power
// `level`), Full access with the desktop's confirm words.
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ModelRow } from "../../../app/shared/session/model";
import { Confirm } from "../act/Confirm";
import { Button } from "../Button";
import { Glyph, Shield } from "../compose/Glyph";
import { Pill } from "../compose/Pill";
import { forMac, newId } from "../compose/state";
import { color, radius, text, opacity, touch } from "../theme";
import { refusal } from "./powers";

type Level = "ask" | "auto" | "full";

/** The desktop's Full Access confirm words. */
export const FULL_ACCESS = { title: "Turn on Full Access?", body: "Agents can use all of these without asking.", shown: "Files · Commands · Internet" };

/** The desktop's levels; HandRaised, ShieldTerminal and ShieldExclamation drawn as shields. */
const LEVELS: { level: Level; label: string; detail: string; mark?: string }[] = [
  { level: "ask", label: "Ask", detail: "Asks before edits and commands" },
  { level: "auto", label: "Auto", detail: "Works on its own, asks before risky actions", mark: "›" },
  { level: "full", label: "Full access", detail: "Unrestricted access to the internet and all your files", mark: "!" },
];

/** A session's row with what its next turn runs at; `level_op`, the last pick Rust took [D30]. */
type LevelRow = ModelRow & { levels?: Level[]; level?: Level | null; level_refused?: string | null; held?: boolean; level_op?: string | null };

export function LevelPill({ id, row, connected }: { id: string; row: LevelRow | undefined; connected: boolean }) {
  const { models } = forMac();
  const [pending, setPending] = useState<{ op: string; level: Level } | null>(null);
  const [asking, setAsking] = useState<{ op: string; level: Level } | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (pending && row?.level_op === pending.op) setPending(null);
  const levels = models.levelsOf(row?.levels ?? [], row?.backend, row?.model);
  const held = row?.held === true;
  const value = held ? "ask" : (pending?.level ?? row?.level ?? levels[0] ?? "ask");
  const shown = LEVELS.find((each) => each.level === value)!;
  const offered = LEVELS.filter((each) => levels.includes(each.level));
  const orange = value === "full" ? color.warning : color.mutedForeground;
  const pick = (level: Level) => {
    if (level === value) return setOpen(false);
    setError(null);
    setAsking({ op: newId(), level });
  };
  const sheet = asking && LEVELS.find((each) => each.level === asking.level)!;
  // The Face ID sheet goes over the levels' sheet while it's open, else on its own: one under way stays.
  const confirm =
    asking && sheet ? (
      <Confirm
        {...(asking.level === "full" ? FULL_ACCESS : { title: `Change to ${sheet.label}?`, shown: `${sheet.label}: ${sheet.detail}` })}
        args={["level", id, asking.level, "--op", asking.op]}
        onDone={(reply) => {
          setAsking(null);
          if (!reply) return;
          setOpen(false);
          if (reply.ok) setPending(asking);
          else setError(refusal(reply));
        }}
      />
    ) : null;
  return (
    <>
      {/* An agent with no levels runs as its CLI always has: no pill, though a sheet already open stays. */}
      {levels.length > 0 ? (
        <Pill label={`Permission level: ${shown.label}`} open={open} disabled={!connected} onPress={() => setOpen(true)} style={{ maxWidth: 160 }}>
          <Shield mark={shown.mark} color={orange} />
          <Text style={[st.pillText, { color: orange }]} numberOfLines={1}>{shown.label}</Text>
        </Pill>
      ) : null}
      {(error ?? row?.level_refused) ? <Text style={st.error} numberOfLines={2}>{error ?? row?.level_refused}</Text> : null}
      {open ? (
        <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
          <ScrollView style={st.page} contentContainerStyle={{ padding: 24, gap: 4 }}>
            <Text style={st.title}>How should the agent’s actions be approved?</Text>
            {held ? <Text style={st.note}>This folder isn't trusted, so sessions here ask first. Change it in the project's settings.</Text> : null}
            {offered.map((each) => {
              const on = each.level === value;
              const disabled = held && each.level !== "ask";
              const tone = each.level === "full" ? color.warning : color.foreground;
              return (
                <Pressable key={each.level} accessibilityRole="radio" accessibilityState={{ checked: on, disabled }} disabled={disabled} onPress={() => pick(each.level)} style={({ pressed }) => [st.option, pressed && { backgroundColor: color.fill }, disabled && { opacity: opacity.disabled }]}>
                  <Shield mark={each.mark} color={tone} />
                  <View style={{ flex: 1 }}>
                    <Text style={[st.optionText, { color: tone }]}>{each.label}</Text>
                    <Text style={[st.detail, each.level === "full" && { color: color.warning }]}>{each.detail}</Text>
                  </View>
                  {on ? <Glyph name="check" color={tone} /> : null}
                </Pressable>
              );
            })}
            <View style={{ height: 16 }} />
            <Button title="Done" secondary onPress={() => setOpen(false)} />
          </ScrollView>
          {confirm}
        </Modal>
      ) : (
        confirm
      )}
    </>
  );
}

const st = StyleSheet.create({
  pillText: { ...text.sm, flexShrink: 1 },
  error: { ...text.xs, color: color.destructive, flexShrink: 1 },
  page: { flex: 1, backgroundColor: color.background },
  title: { ...text.lg, fontWeight: "600", color: color.foreground, marginBottom: 8 },
  note: { ...text.xs, color: color.mutedForeground, marginBottom: 8 },
  option: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: touch, borderRadius: radius.control, paddingHorizontal: 8, paddingVertical: 6 },
  optionText: { ...text.sm },
  detail: { ...text.sm, color: color.mutedForeground },
});
