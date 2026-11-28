// The session's permission pill, as the desktop's session/level.tsx and composer/pickers.tsx: its icon and label,
// orange on Full access; its menu from the bottom asking how the agent's actions should be approved, each level with
// its icon and line and a check on the one in use, Ask alone where the folder isn't trusted. Each change is signed with
// Face ID (power `level`), Full access with the desktop's confirm words.
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { FULL_ACCESS_WORDS, LEVEL_MENU, LEVEL_WORDS, type LevelRow, type PermissionLevel as Level } from "../../../app/shared/session/composer";
import { Confirm } from "../act/Confirm";
import { Check, HandRaised, ShieldExclamation, ShieldTerminal } from "../../../app/ui/src/icons";
import { Pill } from "../compose/Pill";
import { forMac, newId } from "../compose/state";
import { MenuSheet, st as menu } from "../sheets/Sheet";
import { color, space, text, opacity } from "../theme";
import { refusal } from "./powers";

/** The desktop's Full Access confirm words. */
export const FULL_ACCESS = { title: FULL_ACCESS_WORDS.title, body: FULL_ACCESS_WORDS.body, shown: FULL_ACCESS_WORDS.reaches.join(" · ") };

/** The desktop's levels (composer/pickers.tsx), each with its icon. */
const LEVEL_ICONS = { ask: HandRaised, auto: ShieldTerminal, full: ShieldExclamation };
const LEVELS = LEVEL_WORDS.map((each) => ({ ...each, Icon: LEVEL_ICONS[each.level] }));

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
  const orange = value === "full" ? color.fullAccess : color.mutedForeground;
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
          <shown.Icon className="size-icon-md" color={orange} />
          <Text style={[st.pillText, { color: orange }]} numberOfLines={1}>{shown.label}</Text>
        </Pill>
      ) : null}
      {(error ?? row?.level_refused) ? <Text style={st.error} numberOfLines={2}>{error ?? row?.level_refused}</Text> : null}
      {open ? (
        <MenuSheet onClose={() => setOpen(false)}>
          <View style={st.menu}>
            <Text style={st.question}>{LEVEL_MENU.question}</Text>
            {held ? <Text style={st.untrusted}>{LEVEL_MENU.untrusted}</Text> : null}
            {offered.map((each) => {
              const on = each.level === value;
              const disabled = held && each.level !== "ask";
              const tone = each.level === "full" ? color.fullAccess : undefined;
              return (
                <Pressable key={each.level} accessibilityRole="radio" accessibilityState={{ checked: on, disabled }} disabled={disabled} onPress={() => pick(each.level)} style={({ pressed }) => [menu.item, st.row, pressed && { backgroundColor: color.fill }, disabled && { opacity: opacity.disabled }]}>
                  <each.Icon className="size-icon-md text-muted-foreground" />
                  <View style={st.words}>
                    <Text style={[st.name, tone && { color: tone }]}>{each.label}</Text>
                    <Text style={[st.detail, tone && { color: tone }]}>{each.detail}</Text>
                  </View>
                  {on ? <View style={st.mark}><Check className="size-icon-md text-muted-foreground" /></View> : null}
                </Pressable>
              );
            })}
          </View>
          {confirm}
        </MenuSheet>
      ) : (
        confirm
      )}
    </>
  );
}

// The desktop's menu at p-1.5: the sheet's p-1 and half again; its rows py-1.5 with gap-3 and room at the end for the check.
const st = StyleSheet.create({
  pillText: { ...text.sm, flexShrink: 1 },
  error: { ...text.xs, color: color.destructive, flexShrink: 1 },
  menu: { padding: space(0.5) },
  question: { ...text.sm, color: color.mutedForeground, paddingHorizontal: space(2), paddingTop: space(1), paddingBottom: space(1.5) },
  untrusted: { ...text.xs, color: color.mutedForeground, paddingHorizontal: space(2), paddingBottom: space(1.5) },
  row: { gap: space(3), paddingVertical: space(1.5), paddingEnd: space(8) },
  words: { flex: 1 },
  name: { ...text.label, color: color.foreground },
  detail: { ...text.label, color: color.mutedForeground },
  mark: { position: "absolute", end: space(2) },
});
