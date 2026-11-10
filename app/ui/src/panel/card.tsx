import { useEffect, useState } from "react";

import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { Skeleton } from "../components/skeleton";
import { ActionButton } from "./source/action";
import { PrGlyph } from "./source/header";
import type { SourceData } from "./source/panel";
import { StatusLine } from "./source/status-line";
import { prWords, statusWords, type Tone } from "./words";

const TEXT: Record<Tone, string> = { quiet: "text-muted-foreground", good: "text-success", warn: "text-warning", bad: "text-destructive" };

/**
 * The summary card's git section, direction C [D1048, D1095, D1098]: Source's status, smaller, and the same action
 * button with its pre-check line [D1075]; then the branch's pull requests, a row opening the Pull requests tab on
 * it (2.13) [D1017, D1116]. No branch line, PR clock or commits: those live in Source [D1092, D1095, D1114].
 * Unwired [D388]: `onPr` opens nothing yet, and a run only shows the button working.
 */
export function GitCard({ data, nowMs, onPr, running: held = false }: { data: SourceData; nowMs: number; onPr?: (number: number) => void; running?: boolean }) {
  const { source, step } = data;
  const prs = data.prs ?? [];
  const offline = data.offline ?? false;
  // shortcut: a fake run, until 2.15 wires the button to Rust's steps.
  const [running, setRunning] = useState(held);
  useEffect(() => {
    if (!running || held) return;
    const timer = setTimeout(() => setRunning(false), 1500);
    return () => clearTimeout(timer);
  }, [running, held]);

  if (!source || !step) {
    return (
      <div className="px-4 pb-1">
        {data.error ? (
          <ErrorLine error={`Couldn't read this checkout: ${data.error}`} />
        ) : (
          <div aria-busy className="flex flex-col gap-2">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-control-sm" />
          </div>
        )}
      </div>
    );
  }

  const uncommitted = [...source.staged, ...source.changes];
  const resolving = source.merging != null || source.rebasing != null;
  const count = new Set(uncommitted.map((file) => file.path)).size;
  // Nothing to commit and nothing further to do: no button, as in Source.
  const idle = count === 0 && !resolving && (step.kind === "commit" || step.kind === "folderCommit" || step.kind === "landed");
  return (
    <div className={cx("flex flex-col gap-1", offline && "opacity-disabled")} inert={offline}>
      <div className="flex flex-col gap-2 px-4 pb-1">
        <StatusLine small status={statusWords(source, step, count, prs)} files={count > 0 || resolving ? uncommitted : source.sinceBase} />
        {!idle && <ActionButton step={step} nowMs={nowMs} running={running} error={data.stepError ?? null} rejected={data.rejected != null} onRun={() => setRunning(true)} />}
      </div>
      {prs.length > 0 && (
        <>
          <h3 className="flex h-control-xs items-center px-4 text-xs text-muted-foreground">Pull requests</h3>
          <ul className="flex flex-col px-1.5">
            {prs.map((pr) => {
              const words = prWords(pr);
              return (
                <li key={pr.number}>
                  <button
                    type="button"
                    onClick={() => onPr?.(pr.number)}
                    className="flex h-control-sm w-full min-w-0 cursor-pointer items-center gap-2 rounded-control px-2.5 text-start text-sm hover:bg-muted focus-visible:focus-ring svg:size-icon-sm"
                  >
                    <PrGlyph pr={pr} />
                    <span className="shrink-0 text-muted-foreground">#{pr.number}</span>
                    <span className="min-w-0 flex-1 truncate">{pr.title}</span>
                    <span className={cx("shrink-0 text-xs", TEXT[words.tone])}>{words.word}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
