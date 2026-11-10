import { CopyButton } from "../components/copy-button";
import { cx } from "../components/cx";
import { EmptyState } from "../components/empty-state";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { Skeleton } from "../components/skeleton";
import { useDaemon } from "../daemon";
import { Clock, Reload } from "../icons";
import { ago, plural } from "../panel/words";
import { Counts } from "../review/hunks";
import { openTab } from "../shell/tab-store";
import { type HistoryState, refreshHistory, useHistory } from "./store";

/**
 * The History tab (2.29) [D1041, D1111, D1114]: the session's commits since its base from `git log`, newest first, a
 * click opening that commit's diff in a Review tab. No graph and no commit actions. Drawn from props, so the gallery
 * shows each state.
 */
export function HistoryList({ state, connected, nowMs, onCommit, onRefresh }: { state: HistoryState; connected: boolean; nowMs: number; onCommit: (sha: string) => void; onRefresh: () => void }) {
  const { history, error, loading } = state;
  const base = history?.base;
  return (
    <div data-slot="history-tab" className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-control-lg shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="min-w-0 truncate px-1.5 text-sm text-muted-foreground">{history && (base ? `${plural(history.commits.length, "commit")} since ${base}` : "History")}</span>
        {!connected && <span className="px-1.5 text-xs text-muted-foreground">Reconnecting…</span>}
        <div className="flex-1" />
        <TooltipIconButton tooltip="Refresh" size="icon-sm" disabled={!connected} onClick={onRefresh}>
          <Reload className={cx(loading && "animate-spin motion-reduce:animate-none")} />
        </TooltipIconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ErrorLine size="sm" error={error} className="px-4 py-3" />
        {!history ? (
          !error && (
            <div data-slot="history-loading" className="flex flex-col gap-3 p-3">
              {[0, 1, 2].map((index) => (
                <Skeleton key={index} className="h-control-xs w-2/3" />
              ))}
            </div>
          )
        ) : history.commits.length === 0 ? (
          <EmptyState variant="centered" icon={Clock} title={base ? `No commits since ${base}` : "No base to compare with"} className="m-auto" />
        ) : (
          <ul className="flex flex-col p-2">
            {history.commits.map((commit) => (
              <li key={commit.sha} className="flex items-center rounded-control pe-1 hover:bg-muted">
                <button
                  type="button"
                  onClick={() => onCommit(commit.sha)}
                  className="flex h-control-md min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-control px-2 text-start text-sm focus-visible:focus-ring"
                >
                  <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{commit.sha.slice(0, 7)}</span>
                  <span className="w-28 shrink-0 text-end text-xs text-muted-foreground">{ago(commit.atMs, nowMs)}</span>
                  <Counts insertions={commit.added} deletions={commit.removed} />
                </button>
                {/* The full hash, as the row shows only its short one [D1147]. */}
                <CopyButton text={commit.sha} tooltip="Copy commit hash" size="icon-xs" className="text-muted-foreground" />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The tab, live: `owner`'s history from Rust; a commit opens in a Review tab, one tab per commit [D1032, D1041]. */
export function HistoryTab({ owner }: { owner: string }) {
  const state = useHistory(owner);
  const connected = !!useDaemon().daemon;
  return <HistoryList state={state} connected={connected} nowMs={Date.now()} onCommit={(sha) => openTab(owner, "commit", sha)} onRefresh={() => refreshHistory(owner)} />;
}
