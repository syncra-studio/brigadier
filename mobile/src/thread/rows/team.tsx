// Subagents and workers in the thread, after the desktop's workers/{subagents,sentence,live}.tsx.
import { StyleSheet, Text, View } from "react-native";
import type { Item, Progress } from "../../../../app/shared/thread";
import { Chat, PauseCircle, PlayCircle, StopCircle } from "../../../../app/ui/src/icons";
import { WorkerGlyph } from "../../../../app/ui/src/icons/worker-glyphs";
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

/** The glyphs of a sentence's workers, up front: one each, the first four, 2 apart [D103]. */
const Glyphs = ({ ids }: { ids: readonly string[] }) => (
  <View style={st.glyphs} accessible={false}>
    {ids.slice(0, 4).map((id) => <WorkerGlyph key={id} id={id} className="size-4" />)}
  </View>
);

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
        <Glyphs ids={workers.map((worker) => worker.id)} />
        <Words verb={words} />
      </Toggle>
      {open && (
        <View style={s.steps}>
          {workers.map((worker) => (
            <Line key={worker.id}>
              <Glyph><WorkerGlyph id={worker.id} className="size-4 shrink-0" /></Glyph>
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
    return <Line><Glyphs ids={item.workers} /><Words verb={`${workersWord(item.workers)} ${TEAM_WORDS[item.word]}${merged}`} /></Line>;
  }
  const who = workersWord(item.workers).toLowerCase();
  switch (item.type) {
    case "messaged": {
      const words = `${item.byUser ? "You messaged" : "Messaged"} ${who}`;
      if (!item.text) return <Line><Glyph><Chat className="size-4 shrink-0 text-row-foreground" /></Glyph><Words verb={words} /></Line>;
      return (
        <Opening keep={item.id} label={words} detail={<Text style={[s.row, s.box]} selectable>{item.text}</Text>}>
          <Glyph><Chat className="size-4 shrink-0 text-row-foreground" /></Glyph>
          <Words verb={words} />
        </Opening>
      );
    }
    case "stopped":
      return <Line><Glyph><StopCircle className="size-4 shrink-0 text-row-foreground" /></Glyph><Words verb={`${item.byUser ? "You ended" : "Ended"} ${who}`} /></Line>;
    case "paused":
      return <Line><Glyph><PauseCircle className="size-4 shrink-0 text-row-foreground" /></Glyph><Words verb={`Paused ${who}`} /></Line>;
    case "resumed":
      return <Line><Glyph><PlayCircle className="size-4 shrink-0 text-row-foreground" /></Glyph><Words verb={`Resumed ${who}`} /></Line>;
  }
}

const st = StyleSheet.create({
  glyphs: { flexDirection: "row", alignItems: "center", gap: 2, minHeight: 21 },
});
