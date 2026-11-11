import { cx } from "../../components/cx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/tooltip";
import { Branch } from "../../icons";
import type { SourceState } from "../types";
import { ago, clock } from "../words";

/** "Offline · 14:32": when the checkout was last read, beside the branch in Source and on the card [D30, D1206]. */
export function Offline({ readAtMs }: { readAtMs: number | null }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className="size-1.5 rounded-capsule bg-warning" />
      {readAtMs === null ? "Offline" : `Offline · ${clock(readAtMs)}`}
    </span>
  );
}

/**
 * The branch, a small label beside Source's title [D1205]: a click opens its quick pick below it [D1021]; "Live" and
 * when the watch last read the folder are its tip; disconnected, "Offline · 14:32" shows beside it. During a merge or
 * rebase the old "(merging)" and "(rebasing)" stay. A fork here reads "‹branch› · shared with ‹source›" [D1082].
 */
export function BranchLabel({ state, locked, offline = false, readAtMs = null, detached = null, fetchedAtMs, sharedWith = null, open = false, onBranch }: {
  state: SourceState;
  locked: boolean;
  offline?: boolean;
  readAtMs?: number | null;
  /** A detached HEAD's short id: "Detached at 9c41e2a", never "…" [D1187]. */
  detached?: string | null;
  /** When the base's remote was last fetched, null when unknown; left out without a base [D1187]. */
  fetchedAtMs?: number | null;
  sharedWith?: string | null;
  /** Its quick pick is open. */
  open?: boolean;
  onBranch?: () => void;
}) {
  const name = state.branch ?? state.rebasing?.branch ?? (detached ? `Detached at ${detached}` : "…");
  const fetched = fetchedAtMs === undefined ? "" : fetchedAtMs === null ? " · fetch age unknown" : ` · fetched ${ago(fetchedAtMs, Date.now())}`;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={open}
              disabled={locked}
              onClick={onBranch}
              className={cx(
                "flex h-control-sm min-w-0 cursor-pointer items-center gap-1 rounded-control px-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:focus-ring disabled:cursor-default",
                open && "bg-muted",
              )}
            />
          }
        >
          <Branch className="size-icon-xs shrink-0" />
          <span className="min-w-0 truncate">
            {name}
            {sharedWith && ` · shared with ${sharedWith}`}
          </span>
          {(state.merging || state.rebasing) && <span className="shrink-0">{state.merging ? "(merging)" : "(rebasing)"}</span>}
        </TooltipTrigger>
        <TooltipContent>{`${readAtMs === null ? "Live" : `Live · read ${clock(readAtMs)}`}${fetched}`}</TooltipContent>
      </Tooltip>
      {offline && <Offline readAtMs={readAtMs} />}
    </span>
  );
}
