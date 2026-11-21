import { type FC, useContext, useState } from "react";

import { cx } from "../components/cx";
import { WorkerGlyph } from "../icons/worker-glyphs";
import { finished, lowerFirst, type Worker, WorkersPanel, waiting } from "./chip";
import { RowTime } from "./strip";

/*
 * The Workers and Subagents tabs' list [D80]: "Active · N" and "Done · N", a page at a
 * time, view only.
 */

/** What the UI calls a session's workers (the user chose "Workers" over "Subagents"). */
export const WORKERS_LABEL = "Workers";

/**
 * One worker: its glyph, its name and its time (how long it has worked, ticking, or how long ago it finished); while
 * at work, what it does now under its name. A click opens it in the tab.
 */
export const AgentRow: FC<{ worker: Worker }> = ({ worker }) => {
  const { open } = useContext(WorkersPanel);
  const now = finished(worker) ? null : (worker.now ?? worker.word);
  return (
    <li className="flex min-w-0">
      <button
        type="button"
        data-worker-state={worker.kind}
        aria-label={`${worker.name} ${lowerFirst(worker.word)}`}
        title={worker.word}
        onClick={() => open(worker.id)}
        className={cx("flex min-h-10 min-w-0 flex-1 cursor-pointer gap-3 rounded-control px-2 py-2 text-start transition-colors hover:bg-surface-under focus-visible:focus-ring", now ? "items-start" : "items-center")}
      >
        <WorkerGlyph id={worker.id} className={cx("size-5", now && "mt-0.5")} />
        <span className="min-w-0 flex-1">
          <span className="flex min-h-6 items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{worker.name}</span>
            <RowTime worker={worker} ago className="text-xs" />
          </span>
          {now && <span className="block truncate text-sm text-muted-foreground">{now}</span>}
        </span>
      </button>
    </li>
  );
};

/** One section of the list, a page at a time: the first `page` rows, then "Show N more" for the next page. */
function AgentSection({ title, workers, page, trailing, empty, className }: {
  title: string;
  workers: readonly Worker[];
  page: number;
  trailing?: string;
  empty?: string;
  className?: string;
}) {
  const [pages, setPages] = useState(1);
  if (workers.length === 0 && !empty) return null;
  const shown = workers.slice(0, page * pages);
  const hidden = workers.length - shown.length;
  return (
    <section className={cx("flex flex-col", className)}>
      <h3 className="mb-2 flex items-center gap-3 px-2 text-sm text-faint-foreground">
        <span className="flex-1">{`${title} · ${workers.length}`}</span>
        {trailing && <span className="text-xs tabular-nums">{trailing}</span>}
      </h3>
      {workers.length === 0 ? (
        <p className="px-2 py-1 text-sm text-faint-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {shown.map((worker) => (
            <AgentRow key={worker.id} worker={worker} />
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setPages(pages + 1)}
          className="ms-9 mt-1 cursor-pointer self-start rounded-control px-2 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:focus-ring"
        >
          Show {Math.min(hidden, page)} more
        </button>
      )}
    </section>
  );
}

/** Rows a section shows before "Show N more": 4 active and 10 done. */
const ACTIVE_PAGE = 4;
const DONE_PAGE = 10;

/** Every worker of the session, or its CLI's own subagents, in the order given (newest first): at work first, then finished. */
export function WorkerList({ workers, label = WORKERS_LABEL }: { workers: readonly Worker[]; label?: string }) {
  const active = workers.filter((worker) => !finished(worker));
  const done = workers.filter(finished);
  const held = active.filter(waiting).length;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-5">
      <div className="mx-auto flex w-full max-w-reading flex-col">
        <AgentSection
          title="Active"
          workers={active}
          page={ACTIVE_PAGE}
          trailing={held > 0 ? `${held} waiting` : undefined}
          empty={`No active ${label.toLowerCase()}`}
        />
        <AgentSection title="Done" workers={done} page={DONE_PAGE} className="mt-6" />
      </div>
    </div>
  );
}
