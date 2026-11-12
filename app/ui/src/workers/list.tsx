import { type FC, useContext, useState } from "react";

import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { TitlebarTips } from "../components/tooltip";
import { X } from "../icons";
import { WorkerGlyph } from "../icons/worker-glyphs";
import { finished, lowerFirst, onHand, type Worker, WorkersPanel, waiting } from "./chip";
import { type Act, RowTime, StopWorker } from "./strip";

/*
 * The Workers panel, as the old app's RightSidebar tab row, WorkerList and AgentRow [D3012]: "Active · N" and
 * "Done · N", a page at a time.
 */

/** What the UI calls a session's workers (the user chose "Workers" over "Subagents"). */
export const WORKERS_LABEL = "Workers";

/** The panel's tabs and close in a row at its top; a worker's view has its own header in its place. */
export function PanelTabs({ active, tabs, finishedWords, onSelect, onClose }: {
  active: string;
  tabs: readonly string[];
  /** "1 done · 1 ended": the Workers tab's tip after its name. */
  finishedWords?: string;
  onSelect: (tab: string) => void;
  onClose: () => void;
}) {
  return (
    <div role="tablist" aria-label="Right panel" className="flex h-11.5 shrink-0 items-center gap-1 bg-background px-2">
      <TitlebarTips>
        {tabs.map((tab) => (
          <TooltipIconButton
            look="toolbar"
            key={tab}
            role="tab"
            aria-selected={active === tab}
            pressed={active === tab}
            className="w-auto px-2"
            tooltip={tab === WORKERS_LABEL && finishedWords ? `${tab} · ${finishedWords}` : tab}
            onClick={() => onSelect(tab)}
          >
            <span className="text-label">{tab}</span>
          </TooltipIconButton>
        ))}
      </TitlebarTips>
      <span className="flex-1" />
      <TitlebarTips>
        <TooltipIconButton look="toolbar" tooltip="Close right panel" onClick={onClose}>
          <X />
        </TooltipIconButton>
      </TitlebarTips>
    </div>
  );
}

/**
 * One worker on one line: its glyph, its name (a soft "working" while it works), and how long it has worked or how
 * long ago it finished; End in the time's place on hover. Its state in words is its tooltip. A click opens it.
 */
export const AgentRow: FC<{ worker: Worker; act: Act }> = ({ worker, act }) => {
  const { open } = useContext(WorkersPanel);
  const stoppable = onHand(worker);
  return (
    <li className="group/row relative flex min-w-0">
      <button
        type="button"
        data-worker-state={worker.kind}
        aria-label={`${worker.name} ${lowerFirst(worker.word)}`}
        title={worker.word}
        onClick={() => open(worker.id)}
        className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-icon-button px-2 text-start transition-colors hover:bg-fill-subtle focus-visible:focus-ring"
      >
        <WorkerGlyph id={worker.id} className="size-5" />
        <span className="min-w-0 flex-1 truncate text-label">
          {worker.name}
          {worker.kind === "working" && <span className="shimmer text-muted-foreground"> working</span>}
        </span>
        <span className={cx(stoppable && "group-focus-within/row:invisible group-hover/row:invisible")}>
          <RowTime worker={worker} ago className="text-xs" />
        </span>
      </button>
      {/* Its End on the row, without opening the worker first. */}
      {stoppable && (
        <span className="absolute inset-y-0 end-1 hidden items-center group-focus-within/row:flex group-hover/row:flex">
          <StopWorker worker={worker} act={act} />
        </span>
      )}
    </li>
  );
};

/** One section of the list, a page at a time: the first `page` rows, then "Show N more" for the next page. */
function AgentSection({ title, workers, page, trailing, empty, className, act }: {
  title: string;
  workers: readonly Worker[];
  page: number;
  trailing?: string;
  empty?: string;
  className?: string;
  act: Act;
}) {
  const [pages, setPages] = useState(1);
  if (workers.length === 0 && !empty) return null;
  const shown = workers.slice(0, page * pages);
  const hidden = workers.length - shown.length;
  return (
    <section className={cx("flex flex-col", className)}>
      <h3 className="mb-2 flex items-center gap-2 px-2 text-label font-semibold text-muted-foreground">
        <span className="flex-1">{`${title} · ${workers.length}`}</span>
        {trailing && <span className="text-xs tabular-nums">{trailing}</span>}
      </h3>
      {workers.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {shown.map((worker) => (
            <AgentRow key={worker.id} worker={worker} act={act} />
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

/** Every worker of the session, newest first: at work first, then finished. */
export function WorkerList({ workers, act }: { workers: readonly Worker[]; act: Act }) {
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
          empty={`No active ${WORKERS_LABEL.toLowerCase()}`}
          act={act}
        />
        <AgentSection title="Done" workers={done} page={DONE_PAGE} className="mt-6" act={act} />
      </div>
    </div>
  );
}
