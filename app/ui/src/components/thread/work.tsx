import type { StepKind } from "../../thread/item";
import { cx } from "../cx";
import { Chevron, ROW, StepIcon, TOGGLE, Words } from "./activity-row";

const RULE = "flex w-full items-center border-b border-divider pb-2";
const LABEL = "text-sm leading-5.25 text-faint-foreground tabular-nums";

/**
 * Over a turn's work, on a hairline: "Working for 12s" while it runs (`open` null: it doesn't fold), then
 * "Worked for 3m 4s ›", which opens and shuts the turn's folded work.
 */
export function WorkHeader({ label, open, onToggle }: { label: string; open: boolean | null; onToggle: () => void }) {
  if (open === null) {
    return (
      <p className={RULE}>
        <span className={LABEL}>{label}</span>
      </p>
    );
  }
  return (
    <button type="button" aria-expanded={open} onClick={onToggle} className={cx(RULE, "group cursor-pointer gap-1 text-start focus-visible:focus-ring")}>
      <span className={cx(LABEL, "transition-colors group-hover:text-foreground group-focus-visible:text-foreground")}>{label}</span>
      <span className="flex text-faint-foreground">
        <Chevron always />
      </span>
    </button>
  );
}

/**
 * Steps that came one after another, as one row: "Edited 3 files, ran 2 commands ›", with the first kind's
 * icon. While its turn runs, `live` is the running step's words ("Reading blocks.ts"), shimmering.
 */
export function GroupRow({
  kind,
  words,
  live,
  open,
  onToggle,
}: {
  kind: StepKind;
  words: string;
  live?: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" aria-expanded={open} onClick={onToggle} className={cx(ROW, TOGGLE)}>
      <StepIcon kind={kind} />
      <Words verb={live ?? words} live={live !== undefined} />
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
