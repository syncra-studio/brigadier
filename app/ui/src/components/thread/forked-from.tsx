import { BranchAlt } from "../../icons";
import { ROW } from "./activity-row";
import { InfoTip } from "./tip";
import { FORKED_FROM, forkedAfter, forkedSource, tooBigToCopy } from "../../../../shared/words";

/** Where a fork came from, as Rust records it [D48]. `source` is null once that session is gone. */
type ForkOrigin = {
  source: { id: string; title: string } | null;
  where: "worktree" | null;
  /** Its conversation began from the hand-off (proposed). */
  summary: boolean;
  /** Big files and nested repositories its snapshot doesn't hold [D1068] (proposed). */
  leftOut: string[];
};

/**
 * The quiet line where a fork starts, as the old app's ContinuedFrom: "Forked from ‹source› · works in a new worktree";
 * the source's name opens it, and a gone one reads "another session" [D48].
 */
export function ForkedFrom({ origin, chat, onOpen }: { origin: ForkOrigin; chat: boolean; onOpen: (id: string) => void }) {
  const { source, where, summary, leftOut } = origin;
  return (
    <div data-slot="forked-from" className={ROW}>
      <BranchAlt className="size-icon-sm shrink-0" />
      <span className="min-w-0 truncate">
        {FORKED_FROM}{" "}
        {source ? (
          <button type="button" className="cursor-pointer rounded-control text-foreground hover:underline focus-visible:underline focus-visible:focus-ring" onClick={() => onOpen(source.id)}>
            {source.title}
          </button>
        ) : (
          forkedSource(chat)
        )}
        {forkedAfter(where, summary)}
      </span>
      {leftOut.length > 0 && <InfoTip text={tooBigToCopy(leftOut)} />}
    </div>
  );
}
