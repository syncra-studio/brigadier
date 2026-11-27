// A turn's work header and its group lines, after the desktop's components/thread/work.tsx and body.tsx's GroupLine.
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { Item, Turn, Work } from "../../../vendor/brigadier-shared/thread";
import { duration, groupWords, workWords } from "../../../vendor/brigadier-shared/words";
import { type Group, running, shutKey, type StepLine, workKey } from "../lines";
import { color } from "../../theme";
import { Body } from "./body";
import { ThinkingLine } from "./message";
import { s, Toggle, Words } from "./parts";

/** Held this long with no word from what holds it, its header says so [D552]. */
const QUIET_MS = 30 * 60_000;

/** "2 workers", "1 subagent". */
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

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
 * Over a turn's work: "Working for 12s" ticking from the turn's start [D128], with its subagents running and
 * "· waiting for you" [D551]; then "Worked for 3m 4s ›" (with "· waited for 1m 2s"), which opens and shuts the
 * turn's folded work; while it runs, a tap shuts its work away till it ends [D93].
 * shortcut: no workers' count, which needs the session's worker rows the phone doesn't have yet.
 */
export function WorkHeader({ turn, work, open, onToggle }: { turn: Turn; work: Work | undefined; open: boolean | null; onToggle: (id: string) => void }) {
  const live = turn.status === "running" || Boolean(turn.held);
  const now = useSecond(live);
  const subagents = turn.helpers ?? 0;
  const heard = turn.heardAt ?? turn.endedAt ?? now;
  const { waitingSince, waitedMs } = turn;
  const label =
    workWords(turn, work, now) +
    (live && subagents ? ` · ${count(subagents, "subagent")} running` : "") +
    (live && waitingSince != null ? " · waiting for you" : !live && waitedMs !== undefined && waitedMs >= 1000 ? ` · waited for ${duration(waitedMs)}` : "") +
    (turn.held && waitingSince == null && now - heard >= QUIET_MS ? " · no activity for 30 min" : "");
  const words = <Text style={[s.row, { color: color.faint }]}>{label}</Text>;
  if (open === null) return words;
  return (
    <Toggle open={open} label={label} onPress={() => onToggle(live ? shutKey(turn.id) : workKey(turn.id))}>
      {words}
    </Toggle>
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
  return (
    <View>
      {now || (
        <Toggle open={open} label={words} onPress={() => onToggle(item.id)}>
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
