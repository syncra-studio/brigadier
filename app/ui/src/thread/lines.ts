// Which rows the list draws, from the session and what the user has opened: drawing only, no thread rules.
// Rust sends groups and work folds ready-made; this hides what a closed one covers and places the work header.
import type { Item, Session, Turn, Work } from "./item";

export type Group = Extract<Item, { kind: "group" }>;

/** Space above a row: the first row, a new turn, a new part of a turn, the next step of an opened group. */
export type Gap = "first" | "turn" | "part" | "step";

export type Line =
  | { type: "setup"; id: string; gap: Gap; setup: NonNullable<Session["setup"]> }
  /** A finished answer's actions, after the turn's rows. */
  | { type: "marks"; id: string; gap: Gap; item: Extract<Item, { kind: "message" }>; turn: Turn | undefined }
  /** An item: `step` when it is one of an opened group's steps. */
  | { type: "item"; id: string; gap: Gap; item: Item; turn: Turn | undefined; step: boolean; actions?: boolean }
  /** A group row. `steps`: what it shows opened, in one capped box; `live`: its running step or thinking, drawn in its place [D227]. */
  | { type: "group"; id: string; gap: Gap; item: Group; turn: Turn | undefined; open: boolean; steps: StepLine[]; live?: Item }
  /** "Working for 12s" over a running turn's work (`open` null: it doesn't fold), "Worked for 3m 4s" once done. */
  | { type: "work"; id: string; gap: Gap; turn: Turn; work: Work | undefined; open: boolean | null };

type GroupLine = Extract<Line, { type: "group" }>;
export type StepLine = Extract<Line, { type: "item" }>;

/** The id of a turn's work header, which is also what it toggles. */
export const workKey = (turnId: string) => `work:${turnId}`;

/** A user message that starts a turn: a steer joins the running one [D183]. */
const opens = (item: Item | undefined) => item?.kind === "message" && item.role === "user" && !item.steer;

/** A turn's own end said under it: its failure or its Stop, never work, so they open no work header alone [D85]. */
const ends = (item: Item) => (item.kind === "notice" && "reason" in item && item.reason === "failed") || (item.kind === "line" && item.reason === "stopped");

/** A step or a reply: where the work of a turn with no input starts. */
const works = (item: Item) => ["reasoning", "group", "tool", "fileChange", "childAgent", "approval", "question"].includes(item.kind) || (item.kind === "message" && item.role === "assistant");

const within = (n: number | undefined, [first, last]: [number, number]) => n !== undefined && n >= first && n <= last;

export const running = (item: Item) => "progress" in item && (item.progress === "running" || item.progress === "pending");

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
  let kept: number[] = [];
  let group: { span: [number, number]; open: boolean; single: boolean; line: GroupLine | null } | null = null;
  let before: Item | undefined;
  // A turn its agent woke for on its own, with no input: its header goes over its first step or reply [D106, D118].
  let woke: string | null = null;
  let marks: Extract<Line, { type: "marks" }> | null = null;
  const end = () => {
    const last = out.at(-1);
    // Straight under its reply it's part of that row, so hovering the reply shows the time [D297].
    if (marks && last?.type === "item" && last.item === marks.item) last.actions = true;
    else if (marks) out.push(marks);
    marks = null;
  };
  const push = (line: Line) => out.push(line);
  const gap = (item: Item | null, step: boolean): Gap => {
    const last = out.at(-1);
    if (!last) return "first";
    if (item?.kind === "message" && item.role === "user") return "turn";
    if (last.type === "item" && last.item.kind === "message" && last.item.role === "user") return "turn";
    if (item && last.type !== "work" && last.type !== "setup" && last.item.turnId !== item.turnId) return "turn";
    return step ? "step" : "part";
  };

  // A turn stopped or failed before any output still says so under its input.
  const bare = () => {
    const turn = opens(before) ? turns.get(before!.turnId) : undefined;
    if (turn && turn.status !== "running" && turn.status !== "done") push({ type: "work", id: workKey(turn.id), gap: "turn", turn, work: undefined, open: null });
  };

  for (let at = from; at < items.length; at++) {
    const item = items[at]!;
    if (item.hidden) continue;
    // A turn that begins with a switch note rather than an input also ends the bare turn before it.
    if (opens(item) || (before && item.turnId !== before.turnId)) {
      bare();
      end();
    }
    if (opens(item)) {
      starts.push(at);
      counts.push(out.length);
      woke = null;
    } else if (item.turnId !== before?.turnId) woke = item.turnId;
    const wakes = woke === item.turnId && works(item);
    if (wakes) woke = null;
    const turn = turns.get(item.turnId);
    // A turn held open for its subagents draws as running: one block, never folded till it ends [D118].
    const live = turn?.status === "running" || turn?.held === true;
    const done = turn && work.get(turn.id);
    // A turn's work starts right after its input, unless the answer comes straight away: a note before its
    // first step is work too, so a turn that isn't done (running, stopped, failed) or one Rust gave work always has the header.
    // A Stop the turn went on from, by Continue, is no end of it: its line starts the work [D82, D154].
    if (turn && (wakes || (opens(before) && before!.turnId === item.turnId)) && (!ends(item) || live || turn.status === "done") && (item.kind !== "message" || turn.status !== "done" || live || done || turn.denied)) {
      const key = workKey(turn.id);
      const foldable = done !== undefined && !live;
      const opened = foldable ? open.has(key) : null;
      // A turn its agent woke to carry on runs again, the view still holding its earlier work [D106].
      push({ type: "work", id: key, gap: "turn", turn, work: foldable ? done : undefined, open: opened });
      fold = foldable && !opened ? done.folded : null;
      kept = done?.kept ?? [];
    }
    // Its first row too: an empty span (a worktree's turn with only its reply) folds nothing [D85, D118].
    if (fold && !within(item.n, fold)) fold = null;
    before = item;
    // Brigadier's own words to the agent (a Resume, a carry-on) are no row, as the old app's: only the work they start shows.
    if (item.kind === "message" && item.role === "user" && item.origin === "system") continue;

    if (fold && !kept.includes(item.n!)) continue;
    // Thinking is a row only while it lasts.
    if (item.kind === "reasoning" && !item.streaming) continue;
    if (group && within(item.n, group.span)) {
      // A running step or thinking is its group's line until it ends: it never shows apart and moves [D173, D227, D230].
      if (live && group.line && (running(item) || item.kind === "reasoning")) {
        group.line.live = item;
        continue;
      }
      if (!group.open) continue;
      const step: StepLine = { type: "item", id: item.id, gap: group.line ? "step" : gap(item, false), item, turn, step: !group.single };
      if (group.line) group.line.steps.push(step);
      else push(step);
      continue;
    }
    group = null;
    if (item.kind === "group") {
      // Live and folded group alike, as the old app's; Rust counts only ended steps, so a live count only goes up [D173].
      // Folded, a group of one step draws as that step.
      const single = !live && (!done || item.steps.reduce((sum, step) => sum + step.n, 0) === 1);
      const line: GroupLine | null = single ? null : { type: "group", id: item.id, gap: gap(item, false), item, turn, open: open.has(item.id), steps: [] };
      if (line) push(line);
      group = { span: item.span, open: single || line!.open, single, line };
      continue;
    }
    // A send-as-new line follows the reply, so the reply's actions stay directly under it [D204].
    if (item.kind === "started" || item.kind === "forked") end();
    // A turn's actions stay on its last reply, never under the divider that ended it; with no reply drawn, none [D171, D186].
    if (marks && item.kind === "line" && ["stopped", "interrupted", "paused", "review-ended", "stalled"].includes(item.reason)) {
      const reply = out.findLast((line) => line.type === "item" && line.item === marks!.item);
      if (reply?.type === "item") reply.actions = true;
      marks = null;
    }
    if (item.kind === "message" && item.role === "assistant" && item.final) {
      marks = { type: "marks", id: `${item.id}:marks`, gap: "step", item, turn };
    }
    push({ type: "item", id: item.id, gap: gap(item, false), item, turn, step: false });
  }
  bare();
  end();
}
