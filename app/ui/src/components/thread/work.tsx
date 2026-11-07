import type { Item, Turn, Work } from "../../thread/item";
import { type Group, workKey } from "../../thread/lines";
import { groupWords, ORDER, useSecond, workWords } from "../../thread/words";
import { cx } from "../cx";
import { Chevron, ROW, StepIcon, TOGGLE, Words } from "./activity-row";
import { FILE_VERBS, fileName } from "./file-change";
import { toolObject, VERBS } from "./tool";

const RULE = "flex w-full items-center border-b border-divider pb-2";
const LABEL = "text-sm leading-5.25 text-faint-foreground tabular-nums";

/**
 * Over a turn's work, on a hairline: "Working for 12s" ticking while it runs (`open` null: it doesn't fold),
 * then "Worked for 3m 4s ›", which opens and shuts the turn's folded work.
 */
export function WorkHeader({ turn, work, open, onToggle }: { turn: Turn; work: Work | undefined; open: boolean | null; onToggle: (id: string) => void }) {
  const now = useSecond(turn.status === "running");
  const label = workWords(turn, work, now);
  if (open === null) {
    return (
      <p className={RULE}>
        <span className={LABEL}>{label}</span>
      </p>
    );
  }
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => onToggle(workKey(turn.id))}
      className={cx(RULE, "group cursor-pointer gap-1 text-start focus-visible:focus-ring")}
    >
      <span className={cx(LABEL, "transition-colors group-hover:text-foreground group-focus-visible:text-foreground")}>{label}</span>
      <span className="flex text-faint-foreground">
        <Chevron always />
      </span>
    </button>
  );
}

/** A running step's words ("Reading blocks.ts"); nothing once it isn't running. */
function doing(item: Item | undefined): string | undefined {
  if (item?.kind === "tool" && item.progress === "running") {
    const kind = item.step ?? "other";
    return `${VERBS[kind][0]} ${toolObject(kind, item.name, item.input)}`;
  }
  if (item?.kind === "fileChange" && item.progress === "running" && item.changes[0]) {
    return `${FILE_VERBS[item.changes[0].change][0]} ${fileName(item.changes[0].path)}`;
  }
  if (item?.kind === "childAgent" && item.progress === "running") return "Running a subagent";
  return undefined;
}

/**
 * Steps that came one after another, as one row: "Edited 3 files, ran 2 commands ›", with the first kind's
 * icon. While its turn runs and a step of it is running, that step's words ("Reading blocks.ts"), shimmering.
 */
export function GroupRow({ item, live, open, onToggle }: { item: Group; live: Item | undefined; open: boolean; onToggle: (id: string) => void }) {
  const running = doing(live);
  // Live, the icon is the running step's; otherwise the first kind the group names.
  const kind =
    (running && live?.kind === "tool" ? (live.step ?? "other") : running && live?.kind === "fileChange" ? "edit" : running ? "agent" : undefined) ??
    ORDER.find((k) => item.steps.some((step) => step.kind === k)) ??
    "other";
  return (
    <button type="button" aria-expanded={open} onClick={() => onToggle(item.id)} className={cx(ROW, TOGGLE)}>
      <StepIcon kind={kind} />
      <Words verb={running ?? groupWords(item.steps)} live={running !== undefined} />
      <Chevron />
    </button>
  );
}

const WORKING = {
  live: "shimmer",
  stalled: "text-warning",
  interrupted: "text-muted-foreground",
  disconnected: "text-muted-foreground",
} as const;

/**
 * A turn's live status under its rows. Only `live` moves: its motion claims the work is proven live.
 * `stalled` is orange and still; `interrupted` and `disconnected` ("Unknown · last seen working 12s ago")
 * are muted and switch at once.
 */
export function WorkingLine({ state, children }: { state: keyof typeof WORKING; children: string }) {
  return (
    <p role="status" className="flex min-w-0 items-center gap-2">
      {/* Keyed by its words: each new line starts the sweep again. */}
      <span key={state === "live" ? children : undefined} className={cx("w-fit max-w-full truncate text-sm leading-5.25", WORKING[state])}>
        {children}
      </span>
    </p>
  );
}
