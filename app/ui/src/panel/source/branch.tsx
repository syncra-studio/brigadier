import { cx } from "../../components/cx";
import { ArrowDown, ArrowUp, Branch, Publish, Spinner, SyncGlyph } from "../../icons";
import type { SourceState } from "../types";

/**
 * The branch line under the action button, as VS Code's two-part item [D1020]: the branch (a click opens its quick
 * pick) and the sync item (↓ to pull, ↑ to push, one click doing both; a cloud when it was never published). During a
 * merge or rebase the old "(merging)" and "(rebasing)" stay. Off while something is under way.
 */
export function BranchItem({ state, locked, syncing = false, open = false, onBranch, onSync, onPublish }: {
  state: SourceState;
  locked: boolean;
  syncing?: boolean;
  /** Its quick pick is open. */
  open?: boolean;
  onBranch?: () => void;
  onSync?: () => void;
  onPublish?: () => void;
}) {
  const name = state.branch ?? state.rebasing?.branch ?? "…";
  const publish = state.branch !== null && state.upstream === null && state.remote !== null;
  const sync = state.branch !== null && state.upstream !== null;
  const moveLabel = publish ? "Publish Branch" : `Pull ${state.behind} and push ${state.ahead} commits`;
  return (
    <div className="flex h-control-sm min-w-0 items-center gap-1 text-sm">
      <button
        type="button"
        title={`${name}, switch or manage`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={locked}
        onClick={onBranch}
        className={cx(
          "flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-control px-1 text-start text-muted-foreground hover:bg-muted focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-disabled",
          open && "bg-muted",
        )}
      >
        <Branch className="size-icon-sm shrink-0" />
        <span className="min-w-0 truncate text-foreground">{name}</span>
        {(state.merging || state.rebasing) && <span className="shrink-0 text-foreground">{state.merging ? "(merging)" : "(rebasing)"}</span>}
      </button>
      {(sync || publish) && (
        <button
          type="button"
          title={moveLabel}
          aria-label={moveLabel}
          disabled={locked || syncing}
          onClick={publish ? onPublish : onSync}
          className="flex h-full shrink-0 cursor-pointer items-center gap-1 rounded-control px-1.5 text-xs text-muted-foreground tabular-nums hover:bg-muted hover:text-foreground focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-disabled"
        >
          {syncing ? <Spinner className="size-icon-sm animate-spin motion-reduce:animate-none" /> : publish ? <Publish className="size-icon-sm" /> : <SyncGlyph className="size-icon-sm" />}
          {sync && (
            <>
              <span className="flex items-center">
                <ArrowDown className="size-icon-xs" />
                {state.behind}
              </span>
              <span className="flex items-center">
                <ArrowUp className="size-icon-xs" />
                {state.ahead}
              </span>
            </>
          )}
        </button>
      )}
    </div>
  );
}
