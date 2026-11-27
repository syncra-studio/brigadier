// The session's permission pill, as the desktop's session/level.tsx and composer/pickers.tsx: the agent's own levels,
// Ask alone where the folder isn't trusted, each change signed with Face ID (power `level`), Full access with the
// desktop's confirm words. It applies from the next turn.
import { useState } from "react";
import { ActionSheetIOS, Pressable, StyleSheet, Text } from "react-native";
import type { ModelRow } from "../../vendor/brigadier-shared/session/model";
import { Confirm } from "../act/Confirm";
import { forMac, newId } from "../compose/state";
import { color, text } from "../theme";
import { refusal } from "./powers";

type Level = "ask" | "auto" | "full";

const LEVELS: { level: Level; label: string; detail: string }[] = [
  { level: "ask", label: "Ask", detail: "Asks before edits and commands" },
  { level: "auto", label: "Auto", detail: "Works on its own, asks before risky actions" },
  { level: "full", label: "Full access", detail: "Unrestricted access to the internet and all your files" },
];

/** A session's row with what its next turn runs at; `level_op`, the last pick Rust took [D30]. */
type LevelRow = ModelRow & { levels?: Level[]; level?: Level | null; level_refused?: string | null; held?: boolean; level_op?: string | null };

export function LevelPill({ id, row, connected }: { id: string; row: LevelRow | undefined; connected: boolean }) {
  const { models } = forMac();
  const [pending, setPending] = useState<{ op: string; level: Level } | null>(null);
  const [asking, setAsking] = useState<{ op: string; level: Level } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (pending && row?.level_op === pending.op) setPending(null);
  const levels = models.levelsOf(row?.levels ?? [], row?.backend, row?.model);
  const held = row?.held === true;
  const value = held ? "ask" : (pending?.level ?? row?.level ?? levels[0] ?? "ask");
  const shown = LEVELS.find((each) => each.level === value)!;
  const offered = LEVELS.filter((each) => levels.includes(each.level));
  const open = () =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: "How should the agent’s actions be approved?",
        message: held ? "This folder isn't trusted, so sessions here ask first. Change it in the project's settings." : undefined,
        options: [...offered.map((each) => (each.level === value ? `✓ ${each.label}` : each.label)), "Cancel"],
        cancelButtonIndex: offered.length,
        disabledButtonIndices: held ? offered.flatMap((each, at) => (each.level === "ask" ? [] : [at])) : undefined,
      },
      (at) => {
        const picked = offered[at];
        if (!picked || picked.level === value) return;
        setError(null);
        setAsking({ op: newId(), level: picked.level });
      },
    );
  const sheet = asking && LEVELS.find((each) => each.level === asking.level)!;
  return (
    <>
      {/* An agent with no levels runs as its CLI always has: no pill, though a sheet already open stays. */}
      {levels.length > 0 ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Permission level: ${shown.label}`} disabled={!connected} onPress={open} style={({ pressed }) => [st.pill, (pressed || !connected) && { opacity: 0.6 }]}>
          <Text style={[st.pillText, value === "full" && { color: color.warning }]} numberOfLines={1}>{shown.label}</Text>
        </Pressable>
      ) : null}
      {(error ?? row?.level_refused) ? <Text style={st.error} numberOfLines={2}>{error ?? row?.level_refused}</Text> : null}
      {asking && sheet ? (
        <Confirm
          {...(asking.level === "full"
            ? { title: "Turn on Full Access?", body: "Agents can use all of these without asking.", shown: "Files · Commands · Internet" }
            : { title: `Change to ${sheet.label}?`, body: "From the next turn.", shown: `${sheet.label}: ${sheet.detail}` })}
          args={["level", id, asking.level, "--op", asking.op]}
          onDone={(reply) => {
            setAsking(null);
            if (!reply) return;
            if (reply.ok) setPending(asking);
            else setError(refusal(reply));
          }}
        />
      ) : null}
    </>
  );
}

const st = StyleSheet.create({
  pill: { borderRadius: 999, backgroundColor: color.fill, paddingHorizontal: 12, paddingVertical: 6, maxWidth: 160 },
  pillText: { ...text.sm, color: color.foreground },
  error: { ...text.sm, color: color.destructive, flexShrink: 1 },
});
