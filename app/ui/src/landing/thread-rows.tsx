import { Button } from "../components/button";
import { ErrorLine } from "../components/error-line";
import { ROW } from "../components/thread/activity-row";
import { Archive, Branch, Check } from "../icons";
import { Undo, XCircle } from "./icons";

/**
 * "Checks failed on #12 · test (ubuntu-latest)" at the thread's end [D1017], with Send to agent, which leaves a chip
 * above the composer and sends nothing [D1019, D1027], and Open, the PR tab. Added once its chip is waiting.
 */
export function ChecksFailedRow({
  number,
  checks,
  added = false,
  offline = false,
  onSend,
  onOpen,
}: {
  number: number;
  /** The failing checks' names. */
  checks: string[];
  added?: boolean;
  offline?: boolean;
  onSend: () => void;
  onOpen: () => void;
}) {
  return (
    <div data-slot="checks-failed-row" className="flex items-center gap-2">
      <div className={ROW}>
        <XCircle aria-hidden className="size-4 shrink-0 text-destructive" />
        <span className="min-w-0 truncate">
          Checks failed on #{number} · {checks.join(", ")}
        </span>
      </div>
      <Button variant="soft" size="xs" disabled={added || offline} onClick={onSend}>
        {added && <Check />}
        {added ? "Added" : "Send to agent"}
      </Button>
      <Button variant="soft" size="xs" onClick={onOpen}>
        Open
      </Button>
    </div>
  );
}

/** Where a revert of the landing stands: none asked, on its way, made, or failed with why. */
export type Revert = { state: "none" | "pending" | "done" } | { state: "failed"; error: string };

/**
 * "Merged into main · 3 commits", the old MergedRow with Revert and Archive [D1031]. Revert makes one revert commit
 * on the base; the session keeps going and nothing is archived for you.
 */
export function MergedRow({
  base,
  commits,
  revert = { state: "none" },
  archived = false,
  offline = false,
  onRevert,
  onArchive,
}: {
  base: string;
  commits: number;
  revert?: Revert;
  archived?: boolean;
  offline?: boolean;
  onRevert: () => void;
  onArchive: () => void;
}) {
  return (
    <div data-slot="merged-row" className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <div className={ROW}>
          <Branch aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 truncate">
            Merged into {base} · {commits === 1 ? "1 commit" : `${commits} commits`}
            {revert.state === "done" && " · reverted"}
          </span>
        </div>
        {revert.state !== "done" && (
          <Button variant="soft" size="xs" disabled={revert.state === "pending" || offline} onClick={onRevert}>
            <Undo />
            {revert.state === "pending" ? "Reverting…" : "Revert"}
          </Button>
        )}
        {!archived && (
          <Button variant="soft" size="xs" disabled={offline} onClick={onArchive}>
            <Archive />
            Archive
          </Button>
        )}
      </div>
      {revert.state === "failed" && <ErrorLine error={`Couldn't revert: ${revert.error}`} />}
    </div>
  );
}
