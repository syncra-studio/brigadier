import { useState } from "react";

import { useThread } from "../../daemon";
import { errorText, run } from "../../onboarding/api";
import type { Turn, Work } from "../../thread/item";
import { type Group, workKey } from "../../thread/lines";
import { duration, groupWords, ORDER, useSecond, workWords } from "../../thread/words";
import { cx } from "../cx";
import { showToast } from "../toast";
import { Chevron, ROW, StepIcon, TOGGLE, Words } from "./activity-row";
import { finished } from "../../workers/chip";
import { useWorkers } from "../../workers/live";

const RULE = "flex w-full items-center border-b border-divider pb-2";
const LABEL = "text-sm leading-5.25 text-faint-foreground tabular-nums";

/**
 * Over a turn's work, on a hairline: "Working for 12s" ticking from the turn's start, never reset [D128], with
 * "· 1 worker running" while its workers run [D67] and "· waiting for you" while it waits on the user's answer; then
 * "Worked for 3m 4s ›" (with "· waited for 1m 2s" when it waited), which opens and shuts the turn's folded work.
 */
export function WorkHeader({ turn, work, open, onToggle }: { turn: Turn; work: Work | undefined; open: boolean | null; onToggle: (id: string) => void }) {
  const live = turn.status === "running" || Boolean(turn.held);
  const now = useSecond(live);
  const workers = useWorkers(useThread()?.id ?? "").filter((worker) => !finished(worker)).length;
  const { waitingSince, waitedMs } = turn;
  const label =
    workWords(turn, work, now) +
    (live && workers ? ` · ${workers} ${workers === 1 ? "worker" : "workers"} running` : "") +
    (live && waitingSince != null
      ? " · waiting for you"
      : !live && waitedMs !== undefined && waitedMs >= 1000
        ? ` · waited for ${duration(waitedMs)}`
        : "");
  if (open === null) {
    return (
      <p className={RULE}>
        <span className={LABEL}>{label}</span>
        {turn.helpers && now - (turn.heardAt ?? turn.endedAt ?? now) >= QUIET_MS ? <StillWaiting /> : null}
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

/** Past this with no word from its subagents, an answered turn's block offers to stop waiting [D114]. */
const QUIET_MS = 30 * 60_000;

/** "· still waiting · Stop": the user's Stop ends the agent and its subagents, and the block with them. */
function StillWaiting() {
  const id = useThread()?.id;
  const [stopping, setStopping] = useState(false);
  const stop = () => {
    if (!id || stopping) return;
    setStopping(true);
    run(["stop", id]).catch((cause: unknown) => {
      setStopping(false);
      showToast(`Couldn't stop it: ${errorText(cause)}`, { tone: "error" });
    });
  };
  return (
    <span className={LABEL}>
      {" · still waiting · "}
      <button type="button" onClick={stop} disabled={stopping} className="cursor-pointer rounded-control text-strip-foreground hover:text-foreground focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-disabled">
        {stopping ? "Stopping…" : "Stop"}
      </button>
    </span>
  );
}

/**
 * Steps that came one after another, as one row: "Edited 3 files, ran 2 commands ›", with the first kind's icon.
 * Its count only goes up while the turn runs; a running step draws in its place until it ends (GroupLine) [D173, D227].
 */
export function GroupRow({ item, open, onToggle }: { item: Group; open: boolean; onToggle: (id: string) => void }) {
  const kind = ORDER.find((k) => item.steps.some((step) => step.kind === k)) ?? "other";
  return (
    <button type="button" aria-expanded={open} onClick={() => onToggle(item.id)} className={cx(ROW, TOGGLE)}>
      <StepIcon kind={kind} />
      <Words verb={groupWords(item.steps)} />
      <Chevron />
    </button>
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
