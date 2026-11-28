// Subagents and workers in the thread, after the desktop's workers/{subagents,sentence,live,chip}.tsx.
import { useSyncExternalStore } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Row, WorkerStateKind } from "../../../../app/shared/rows";
import type { Item } from "../../../../app/shared/thread";
import { batchNames, batchWords, finished, outcomeWords, stillRunning, subagentOf, teamStepVerb, UNKNOWN_WORKER } from "../../../../app/shared/workers";
import { Chat, PauseCircle, PlayCircle, StopCircle } from "../../../../app/ui/src/icons";
import { WorkerGlyph } from "../../../../app/ui/src/icons/worker-glyphs";
import { lists } from "../../mac/mac";
import { color, radius, space, text } from "../../theme";
import { Glyph, Line, Opening, s, Toggle, useKept } from "./parts";

type Agent = Extract<Item, { kind: "childAgent" }>;
type Worker = { id: string; name: string; kind: WorkerStateKind; word: string };

/** The workers a row names, by their rows; one the phone no longer has reads "a worker", ended, as the desktop's useNamed. */
function useNamed(ids: readonly string[]): Worker[] {
  const rows = useSyncExternalStore(lists.subscribe, () => lists.get().rows);
  return ids.map((id) => {
    const row: Row | undefined = rows.find((each) => each.id === id);
    return row?.worker ? { id, name: row.title, kind: row.worker.kind, word: row.worker.word } : { id, name: UNKNOWN_WORKER, kind: "stopped", word: "Ended" };
  });
}

/** The glyphs of a sentence's workers, up front: one each, the first four, 2 apart [D103]. */
const Glyphs = ({ workers }: { workers: readonly Worker[] }) => (
  <View style={st.glyphs} accessible={false}>
    {workers.slice(0, 4).map((worker) => <WorkerGlyph key={worker.id} id={worker.id} className="size-4" />)}
  </View>
);

/**
 * Workers or subagents started together, one row per batch [D103]: their glyphs and "A and B started working",
 * "… finished" once all are. Opened, a row each with how it went; their tabs are the Mac's.
 */
function BatchRow({ keep, workers, endRows = false }: { keep: string; workers: readonly Worker[]; endRows?: boolean }) {
  const [open, setOpen] = useKept(keep);
  const words = `${batchNames(workers)} ${batchWords(workers, endRows)}`;
  return (
    <View>
      <Toggle open={open} label={words} onPress={() => setOpen(!open)}>
        <Glyphs workers={workers} />
        <Text style={[s.row, s.shrink]} numberOfLines={1}>{words}</Text>
      </Toggle>
      {open && (
        <View style={s.steps}>
          {workers.map((worker) => (
            <Line key={worker.id}>
              <Glyph><WorkerGlyph id={worker.id} className="size-4 shrink-0" /></Glyph>
              <Text style={[s.row, s.shrink]} numberOfLines={1}>{worker.name} {outcomeWords(worker)}</Text>
            </Line>
          ))}
        </View>
      )}
    </View>
  );
}

/** A batch of the agent CLI's own subagents [D78, D115]. */
export function SubagentRow({ items }: { items: readonly Agent[] }) {
  return <BatchRow keep={items[0]!.id} workers={items.map(subagentOf)} />;
}

/** A worker's name as the desktop's WorkerName draws it, its glyph before it where the sentence has none up front. */
function Names({ workers }: { workers: readonly Worker[] }) {
  const named = workers.length > 3 ? workers.slice(0, 2) : workers;
  const more = workers.length - named.length;
  const parts = [...named.map((worker) => ({ id: worker.id, name: worker.name })), ...(more > 0 ? [{ id: "", name: `${more} more` }] : [])];
  return (
    <>
      {parts.map((part, index) => (
        <View key={part.id || "more"} style={st.part}>
          {index > 0 && <Text style={s.row}>{index === parts.length - 1 ? " and " : ", "}</Text>}
          <View style={st.name}>
            {part.id ? <WorkerGlyph id={part.id} className="size-icon-xs shrink-0" /> : null}
            <Text style={[s.row, s.shrink, part.id ? { color: color.stripForeground } : null]} numberOfLines={1}>{part.name}</Text>
          </View>
        </View>
      ))}
    </>
  );
}

type Team = Extract<Item, { kind: "team" | "team_step" | "team_still" }>;

const STEP_ICONS = { messaged: Chat, stopped: StopCircle, paused: PauseCircle, resumed: PlayCircle } as const;

/**
 * The parent's rows of its workers [D3009, D3010]: a batch's start, what the lead did to them, and those Stop left
 * running. Their tabs and Stop them are the Mac's.
 */
export function TeamRow({ item }: { item: Team }) {
  const workers = useNamed(item.workers);
  if (item.kind === "team") return <BatchRow keep={item.id} workers={workers} endRows />;
  if (item.kind === "team_still") {
    const live = workers.filter((worker) => !finished(worker));
    if (live.length === 0) return null;
    return <Line><Glyphs workers={live} /><Text style={[s.row, s.shrink]} numberOfLines={1}>{stillRunning(live.length)}</Text></Line>;
  }
  const Icon = STEP_ICONS[item.type];
  const head = (
    <>
      <Glyph><Icon className="size-4 shrink-0 text-row-foreground" /></Glyph>
      <View style={st.words}>
        <Text style={s.row}>{teamStepVerb(item)}</Text>
        <Names workers={item.type === "messaged" ? workers.slice(0, 1) : workers} />
      </View>
    </>
  );
  if (item.type !== "messaged" || !item.text) return <Line>{head}</Line>;
  return (
    <Opening keep={item.id} label={`${teamStepVerb(item)} ${workers[0]?.name ?? UNKNOWN_WORKER}`} detail={<View style={st.brief}><Text style={[text.sm, { color: color.toolBoxText }]} selectable>{item.text}</Text></View>}>
      {head}
    </Opening>
  );
}

const st = StyleSheet.create({
  glyphs: { flexDirection: "row", alignItems: "center", gap: space(0.5), minHeight: space(5.25) },
  words: { flexDirection: "row", alignItems: "center", gap: space(1), flexShrink: 1, minWidth: 0 },
  part: { flexDirection: "row", alignItems: "center", flexShrink: 1 },
  name: { flexDirection: "row", alignItems: "center", gap: space(1), flexShrink: 1 },
  // What a worker was told, in a quiet box (the desktop's QuietBrief).
  brief: { borderRadius: radius.control, backgroundColor: color.codeSurface, paddingHorizontal: space(3), paddingVertical: space(2) },
});
