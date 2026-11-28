// A turn's work header and its group lines, after the desktop's components/thread/work.tsx and body.tsx's GroupLine.
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Item, Turn, Work } from "../../../../app/shared/thread";
import { groupWords, ORDER, workHeaderWords } from "../../../../app/shared/words";
import { Lightbulb, Mcp } from "../../../../app/ui/src/icons";
import { type Group, running, shutKey, type StepLine, workKey } from "../../../../app/shared/lines";
import { color } from "../../theme";
import { Body } from "./body";
import { ThinkingLine } from "./message";
import { Chevron, s, StepIcon, Toggle, Words } from "./parts";

/** Now, each second while `live`, as the desktop's useSecond. */
function useSecond(live: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return live ? now : Date.now();
}

/**
 * Over a turn's work, with no hairline [D93]: "Working for 12s" ticking from the turn's start [D128], with what it
 * waits on and "· waiting for you" [D551]; then "Worked for 3m 4s ›" (with "· waited for 1m 2s"), which opens and shuts
 * the turn's folded work; while it runs, a tap shuts its work away till it ends [D93].
 * shortcut: no workers' count, which needs the session's worker rows the phone doesn't have yet.
 */
export function WorkHeader({ turn, work, open, onToggle }: { turn: Turn; work: Work | undefined; open: boolean | null; onToggle: (id: string) => void }) {
  const live = turn.status === "running" || Boolean(turn.held);
  const now = useSecond(live);
  const label = workHeaderWords(turn, work, now, 0, 0, turn.heardAt ?? turn.endedAt ?? now);
  const words = <Text style={st.label}>{label}</Text>;
  if (open === null) return <View style={st.rule}>{words}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open }} onPress={() => onToggle(live ? shutKey(turn.id) : workKey(turn.id))} hitSlop={6} style={({ pressed }) => [st.rule, s.with, pressed && { opacity: 0.6 }]}>
      {words}
      <Chevron open={open} faint />
    </Pressable>
  );
}

/**
 * The group line for every run of steps [D697]. Live, it is one line saying what it does now: its running step, its
 * thought, or Thinking while it is the running turn's latest run. Once the run ends, what its steps did [D755, D762].
 */
export function GroupLine({ item, turn, open, steps, live, members, onToggle }: { item: Group; turn: Turn | undefined; open: boolean; steps: Pick<StepLine, "id" | "item" | "turn" | "step">[]; live?: Item; members: readonly Item[]; onToggle: (id: string) => void }) {
  const going = turn?.status === "running" || turn?.held === true;
  const now = live?.kind === "reasoning" ? <ThinkingLine heading={live.heading} /> : live ? <Body item={live} turn={turn} step={false} /> : item.run && going ? <ThinkingLine /> : null;
  const ended = members.filter((member) => !running(member) && !(member.kind === "reasoning" && member.streaming));
  if (!now && !ended.length) return null;
  const words = groupWords(ended);
  const kind = ORDER.find((k) => item.steps.some((step) => step.kind === k));
  return (
    <View>
      {now || (
        <Toggle open={open} label={words} onPress={() => onToggle(item.id)}>
          {/* Only MCP tools: the MCP glyph, as their own rows [D666]; only thoughts, the thought's. */}
          <StepIcon kind={kind} icon={!kind ? Lightbulb : kind === "other" && item.steps.every((step) => step.server) ? Mcp : undefined} />
          <Words verb={words} />
        </Toggle>
      )}
      {open && steps.length > 0 && (
        <View style={s.steps}>
          {steps.map((step) => (
            <Body key={step.id} item={step.item} turn={step.turn} step={step.step} />
          ))}
        </View>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  rule: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", maxWidth: "100%" },
  label: { ...s.row, flexShrink: 1, color: color.faintForeground, fontVariant: ["tabular-nums"] },
});
