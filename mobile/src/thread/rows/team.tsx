// Subagents and workers in the thread, after the desktop's workers/{subagents,sentence,live}.tsx.
import { Text, View } from "react-native";
import type { Item, Progress } from "../../../vendor/brigadier-shared/thread";
import { Glyph, Line, OnMac, Opening, s, useKept, Toggle, Words } from "./parts";

type Agent = Extract<Item, { kind: "childAgent" }>;
type Kind = "working" | "done" | "failed" | "stopped";
type Worker = { id: string; name: string; kind: Kind; word: string };

const STATES: Record<Progress, [Kind, string]> = {
  pending: ["working", "Waiting"],
  running: ["working", "Working"],
  done: ["done", "Done"],
  failed: ["failed", "Failed"],
  cancelled: ["stopped", "Stopped"],
};

const asSubagent = (item: Agent): Worker => {
  const [kind, word] = STATES[item.progress];
  return { id: item.id, name: item.title || "A subagent", kind, word };
};

/** "A", "A and B", "A, B and C"; past three, "A, B and 4 more". */
const said = (names: string[]) => {
  const named = names.length > 3 ? [...names.slice(0, 2), `${names.length - 2} more`] : names;
  return named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : (named[0] ?? "");
};

function batchWords(workers: readonly Worker[]): string {
  if (workers.some((worker) => worker.kind === "working")) return "started working";
  if (workers.some((worker) => worker.kind === "failed")) return "finished with errors";
  if (workers.some((worker) => worker.kind === "done")) return "finished";
  return "stopped";
}

const outcome = (worker: Worker) => (worker.kind === "working" ? "started working" : worker.kind === "done" ? "finished" : worker.word.charAt(0).toLowerCase() + worker.word.slice(1));

/**
 * Subagents started together, one row per batch [D103]: "A and B started working", "… finished" once all are.
 * Opened, a row each with how it went; their Subagents tab is the Mac's.
 */
export function SubagentRow({ items }: { items: readonly Agent[] }) {
  const [open, setOpen] = useKept(items[0]!.id);
  const workers = items.map(asSubagent);
  const words = `${said(workers.map((worker) => worker.name))} ${batchWords(workers)}`;
  return (
    <View>
      <Toggle open={open} label={words} onPress={() => setOpen(!open)}>
        <Glyph g="◇" />
        <Words verb={words} />
      </Toggle>
      {open && (
        <View style={s.steps}>
          {workers.map((worker) => (
            <Line key={worker.id}>
              <Glyph g="◇" />
              <Words verb={`${worker.name} ${outcome(worker)}`} />
            </Line>
          ))}
        </View>
      )}
    </View>
  );
}

type Team = Extract<Item, { kind: "team" | "team_step" | "team_still" }>;

/** Workers by count: their names and states are the Mac's rows, which the phone doesn't have yet. */
const workersWord = (ids: readonly string[]) => (ids.length === 1 ? "A worker" : `${ids.length} workers`);
const TEAM_WORDS = { started: "started working", finished: "finished", failed: "finished with errors", stopped: "stopped" } as const;

/**
 * The parent's rows of its workers [D3009, D3010]: a batch's start, and what the lead did to them.
 * shortcut: workers read by count and the item's own word, not their names and live states, until the phone has worker rows.
 */
export function TeamRow({ item }: { item: Team }) {
  if (item.kind === "team_still") return <OnMac />;
  if (item.kind === "team") {
    const merged = item.merge ? (item.merge.ok ? ` · Merged into ${item.merge.into}` : " · Not merged") : "";
    return <Line><Glyph g="◇" /><Words verb={`${workersWord(item.workers)} ${TEAM_WORDS[item.word]}${merged}`} /></Line>;
  }
  const who = workersWord(item.workers).toLowerCase();
  switch (item.type) {
    case "messaged": {
      const words = `${item.byUser ? "You messaged" : "Messaged"} ${who}`;
      if (!item.text) return <Line><Glyph g="✉" /><Words verb={words} /></Line>;
      return (
        <Opening keep={item.id} label={words} detail={<Text style={[s.row, s.box]} selectable>{item.text}</Text>}>
          <Glyph g="✉" />
          <Words verb={words} />
        </Opening>
      );
    }
    case "stopped":
      return <Line><Glyph g="■" /><Words verb={`${item.byUser ? "You ended" : "Ended"} ${who}`} /></Line>;
    case "paused":
      return <Line><Glyph g="‖" /><Words verb={`Paused ${who}`} /></Line>;
    case "resumed":
      return <Line><Glyph g="▷" /><Words verb={`Resumed ${who}`} /></Line>;
  }
}
