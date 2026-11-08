// Which rows the list draws, from the session and what the user has opened: drawing only, no thread rules.
// Rust sends groups and work folds ready-made; this hides what a closed one covers and places the work header.
import type { Item, Turn, Work } from "./item";

export type Group = Extract<Item, { kind: "group" }>;

/** Space above a row: the first row, a new turn, a new part of a turn, the next step of an opened group. */
export type Gap = "first" | "turn" | "part" | "step";

export type Line =
  /** An item: `step` when it is one of an opened group's steps. */
  | { type: "item"; id: string; gap: Gap; item: Item; turn: Turn | undefined; step: boolean }
  /** A group row. `live`: its newest step while the turn runs, for the running step's words. */
  | { type: "group"; id: string; gap: Gap; item: Group; turn: Turn | undefined; open: boolean; live: Item | undefined }
  /** "Working for 12s" over a running turn's work (`open` null: it doesn't fold), "Worked for 3m 4s" once done. */
  | { type: "work"; id: string; gap: Gap; turn: Turn; work: Work | undefined; open: boolean | null };

type GroupLine = Extract<Line, { type: "group" }>;

/** The id of a turn's work header, which is also what it toggles. */
export const workKey = (turnId: string) => `work:${turnId}`;

const within = (n: number | undefined, [first, last]: [number, number]) => n !== undefined && n >= first && n <= last;

type Walk = { items: readonly Item[]; out: Line[]; starts: number[]; counts: number[] };

/**
 * A function giving the lines to draw. `open` holds the ids of opened groups and work headers; everything else
 * stays closed. It walks again only from the turn where the items first differ from last time, so a streaming
 * update costs the last turn plus one pass of reference checks; a change to turns, work or `open` walks it all.
 */
export function lineMaker() {
  let last: (Walk & { turns: unknown; work: unknown; open: unknown }) | null = null;
  return (items: readonly Item[], turns: ReadonlyMap<string, Turn>, work: ReadonlyMap<string, Work>, open: ReadonlySet<string>): Line[] => {
    let from = 0;
    if (last && last.turns === turns && last.work === work && last.open === open) {
      const shared = Math.min(items.length, last.items.length);
      let same = 0;
      while (same < shared && items[same] === last.items[same]) same++;
      if (same === items.length && same === last.items.length) return last.out;
      // Back to the start of the turn holding the first change, where the walk holds no state.
      let at = last.starts.length;
      while (at > 0 && last.starts[at - 1]! > same) at--;
      if (at > 0) from = at - 1;
    }
    const walk: Walk = last && from > 0
      ? { items, out: last.out.slice(0, last.counts[from]), starts: last.starts.slice(0, from), counts: last.counts.slice(0, from) }
      : { items, out: [], starts: [], counts: [] };
    lines(walk, from > 0 ? last!.starts[from]! : 0, turns, work, open);
    last = { ...walk, turns, work, open };
    return walk.out;
  };
}

function lines({ items, out, starts, counts }: Walk, from: number, turns: ReadonlyMap<string, Turn>, work: ReadonlyMap<string, Work>, open: ReadonlySet<string>): void {
  let fold: [number, number] | null = null;
  let group: { span: [number, number]; open: boolean; single: boolean; line: GroupLine | null } | null = null;
  let before: Item | undefined;
  const push = (line: Line) => out.push(line);
  const gap = (item: Item | null, step: boolean): Gap => {
    const last = out.at(-1);
    if (!last) return "first";
    if (item?.kind === "message" && item.role === "user") return "turn";
    if (last.type === "item" && last.item.kind === "message" && last.item.role === "user") return "turn";
    if (item && last.type !== "work" && last.item.turnId !== item.turnId) return "turn";
    return step ? "step" : "part";
  };

  for (let at = from; at < items.length; at++) {
    const item = items[at]!;
    if (item.kind === "message" && item.role === "user") {
      starts.push(at);
      counts.push(out.length);
    }
    const turn = turns.get(item.turnId);
    const done = turn && work.get(turn.id);
    // A turn's work starts right after its input, unless the answer comes straight away: a note before its
    // first step is work too, so a running turn or one Rust gave work always has the header.
    if (turn && before?.kind === "message" && before.role === "user" && before.turnId === item.turnId && (item.kind !== "message" || turn.status === "running" || done)) {
      const key = workKey(turn.id);
      const foldable = done !== undefined && turn.status !== "running";
      const opened = foldable ? open.has(key) : null;
      push({ type: "work", id: key, gap: "turn", turn, work: done, open: opened });
      fold = foldable && !opened ? done.folded : null;
    } else if (fold && !within(item.n, fold)) fold = null;
    before = item;

    if (fold) continue;
    // Thinking is a row only while it lasts.
    if (item.kind === "reasoning" && !item.streaming) continue;
    if (group && within(item.n, group.span)) {
      if (group.line && turn?.status === "running") group.line.live = item;
      if (!group.open) continue;
      push({ type: "item", id: item.id, gap: gap(item, !group.single), item, turn, step: !group.single });
      continue;
    }
    group = null;
    if (item.kind === "group") {
      // A finished group of one step draws as that step.
      const single = turn?.status !== "running" && item.steps.reduce((sum, step) => sum + step.n, 0) === 1;
      const line: GroupLine | null = single ? null : { type: "group", id: item.id, gap: gap(item, false), item, turn, open: open.has(item.id), live: undefined };
      if (line) push(line);
      group = { span: item.span, open: single || line!.open, single, line };
      continue;
    }
    push({ type: "item", id: item.id, gap: gap(item, false), item, turn, step: false });
  }
}
