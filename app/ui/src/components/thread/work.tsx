import { useThread } from "../../daemon";
import { Lightbulb, Mcp } from "../../icons";
import type { Item, Turn, Work } from "../../thread/item";
import { type Group, workKey } from "../../thread/lines";
import { duration, groupWords, ORDER, useSecond, workWords } from "../../thread/words";
import { cx } from "../cx";
import { Markdown } from "../../thread/markdown";
import { Chevron, OpeningRow, ROW, StepIcon, TOGGLE, Words } from "./activity-row";
import { finished } from "../../workers/chip";
import { useWorkers } from "../../workers/live";

const RULE = "flex w-full items-center border-b border-divider pb-2";
const LABEL = "text-sm leading-5.25 text-faint-foreground tabular-nums";

/** "2 workers", "1 subagent". */
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Over a turn's work, on a hairline: "Working for 12s" ticking from the turn's start, never reset [D128], with what it
 * waits on, a count per kind: "· 2 workers · 1 subagent running", "· 1 worker paused" [D67, D550, D553], and
 * "· waiting for you" while it waits on the user's answer, a worker's or subagent's too [D551]; held 30 minutes with no
 * word from any of them, "· no activity for 30 min" [D552]. Then "Worked for 3m 4s ›" (with "· waited for 1m 2s" when
 * it waited), which opens and shuts the turn's folded work.
 */
export function WorkHeader({ turn, work, open, onToggle }: { turn: Turn; work: Work | undefined; open: boolean | null; onToggle: (id: string) => void }) {
  const live = turn.status === "running" || Boolean(turn.held);
  const now = useSecond(live);
  const all = useWorkers(useThread()?.id ?? "");
  const workers = all.filter((worker) => !finished(worker));
  const paused = all.filter((worker) => worker.kind === "paused").length;
  const subagents = turn.helpers ?? 0;
  const running = [workers.length && count(workers.length, "worker"), subagents && count(subagents, "subagent")].filter(Boolean).join(" · ");
  const heard = Math.max(turn.heardAt ?? turn.endedAt ?? now, ...workers.map((worker) => worker.heardAt ?? 0));
  const { waitingSince, waitedMs } = turn;
  const label =
    workWords(turn, work, now) +
    (live && running ? ` · ${running} running` : "") +
    (live && paused ? ` · ${count(paused, "worker")} paused` : "") +
    (live && waitingSince != null
      ? " · waiting for you"
      : !live && waitedMs !== undefined && waitedMs >= 1000
        ? ` · waited for ${duration(waitedMs)}`
        : "") +
    (turn.held && waitingSince == null && now - heard >= QUIET_MS ? " · no activity for 30 min" : "");
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

/** Held this long with no word from what holds it, its header says so; no Stop, no limit [D552]. */
const QUIET_MS = 30 * 60_000;

/**
 * Steps that came one after another, as one row saying what they did: "Read Calculator's window and listed Brigadier
 * sessions", with the first kind's icon [D697, D755]. It says only steps that ended; a running one draws under it (GroupLine).
 */
export function GroupRow({ item, members, open, onToggle }: { item: Group; members: readonly Item[]; open: boolean; onToggle: (id: string) => void }) {
  const kind = ORDER.find((k) => item.steps.some((step) => step.kind === k));
  return (
    <button type="button" aria-expanded={open} onClick={() => onToggle(item.id)} className={cx(ROW, TOGGLE)}>
      {/* Only MCP tools: the MCP glyph, as their own rows [D666]; only thoughts, the thought's. */}
      <StepIcon kind={kind} icon={!kind ? Lightbulb : kind === "other" && item.steps.every((step) => step.server) ? Mcp : undefined} />
      <Words verb={groupWords(members)} />
      <Chevron />
    </button>
  );
}

/** A thought's line: its heading or first words, opening to the whole thought [D752]. */
export function ThoughtRow({ item }: { item: Extract<Item, { kind: "reasoning" }> }) {
  const words = item.heading || item.text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim() || "Thought";
  return (
    <OpeningRow keep={item.id} detail={<div className="ps-5.5"><Markdown text={item.text} keep={item.id} /></div>}>
      <StepIcon icon={Lightbulb} />
      <Words verb={words} />
    </OpeningRow>
  );
}

const WORKING = {
  live: "shimmer",
  stalled: "text-muted-foreground",
  interrupted: "text-muted-foreground",
  disconnected: "text-muted-foreground",
} as const;

/**
 * A turn's live status under its rows. Only `live` moves: its motion claims the work is proven live.
 * `stalled`, `interrupted` and `disconnected` are muted and still, their words saying which; they switch at once.
 * `disconnected` names the last state known, whatever it was ("Unknown · last seen stalled 12s ago").
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
