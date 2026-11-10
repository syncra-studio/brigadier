import { cx } from "../components/cx";
import { Skeleton } from "../components/skeleton";
import { ActionButton } from "./source/action";
import { PrGlyph } from "./source/header";
import { ReadError, type SourceData, type SourceOps } from "./source/panel";
import { StatusLine } from "./source/status-line";
import { useSourceStep } from "./source/step";
import { prWords, statusWords, type Tone } from "./words";

const TEXT: Record<Tone, string> = { quiet: "text-muted-foreground", good: "text-success", warn: "text-warning", bad: "text-destructive" };

/**
 * The summary card's git section, direction C [D1048, D1095, D1098]: Source's status, smaller, and the same action
 * button with its pre-check line [D1075]; then the branch's pull requests, a row opening the Pull requests tab on
 * it (2.13) [D1017, D1116]. No branch line, PR clock or commits: those live in Source [D1092, D1095, D1114].
 * It reads Source's data and runs Source's own step and moves [D1145, D1148].
 * Without `ops` (the gallery) it moves nothing; `running`: the gallery's button at work.
 */
export function GitCard({ data, nowMs, draftKey, session = null, ops, onPr, running = false }: {
  data: SourceData;
  nowMs: number;
  draftKey?: string;
  session?: string | null;
  ops?: SourceOps;
  onPr?: (number: number) => void;
  running?: boolean;
}) {
  const { source } = data;
  const offline = data.offline ?? false;
  const { prs, button, dialogs } = useSourceStep({ data, state: source, draftKey, session, card: true, ops, move: (paths, to) => ops?.[to === "staged" ? "stage" : "unstage"](paths) });

  if (!source) {
    return (
      <div className="px-4 pb-1">
        {data.error ? (
          <ReadError error={data.error} onRetry={ops?.retry} />
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
  return (
    <div className={cx("flex flex-col gap-1", offline && "opacity-disabled")} inert={offline}>
      <div className="flex flex-col gap-2 px-4 pb-1">
        {/* A watch that failed after its first read: the last read stays under it, as in Source [D30]. */}
        {data.error && !offline && <ReadError error={data.error} onRetry={ops?.retry} />}
        <StatusLine small status={statusWords(source, data.step, count, prs)} files={count > 0 || resolving ? uncommitted : source.sinceBase} />
        {button && <ActionButton nowMs={nowMs} running={running} {...button} />}
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
      {dialogs}
    </div>
  );
}
