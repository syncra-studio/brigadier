import type { ReactNode } from "react";

import { cx } from "../components/cx";
import { Skeleton } from "../components/skeleton";
import { Branch } from "../icons";
import { ActionButton } from "./source/action";
import { Offline } from "./source/branch";
import { ReadError, type SourceData, type SourceOps } from "./source/panel";
import { Counts, Line, PrLine } from "./source/rows";
import { useSourceStep } from "./source/step";

/** One of the card's parts, a hairline under it as the old card's [D1075, D1198]. */
function CardSection({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className="relative flex flex-col pb-2 after:absolute after:inset-x-5 after:bottom-0 after:h-px after:origin-bottom after:scale-y-50 after:bg-divider last:pb-0 last:after:hidden">
      {title && <header className="flex h-7 min-w-0 items-center ps-5 pe-3.5 text-label text-muted-foreground">{title}</header>}
      <div className="flex min-w-0 flex-col gap-0.5 px-5">{children}</div>
    </section>
  );
}

/**
 * The summary card's git part, The mix [D1186, D1198]: the project as a quiet title, the branch row with its +/−
 * counts (no uncommitted count, D1209), the one button and its line under it, a hairline, then the branch's pull
 * requests in the old card's icons, words and colours, a row opening the Pull requests tab on it [D1017, D1116].
 * No status sentence: the rows say it. The button, its line and the PR rows are Source's, from the same model and
 * moves [D1145, D1148, D1199]. Disconnected, "Offline · 14:32" takes the counts' place and the rest dims [D30, D1206].
 * Without `ops` (the gallery) it moves nothing; `running`: the gallery's button at work.
 */
export function GitCard({ data, nowMs, project = null, draftKey, session = null, ops, onPr, running = false }: {
  data: SourceData;
  nowMs: number;
  project?: string | null;
  draftKey?: string;
  session?: string | null;
  ops?: SourceOps;
  onPr?: (number: number) => void;
  running?: boolean;
}) {
  const { source } = data;
  const offline = data.offline ?? false;
  const { prs, button, dialogs } = useSourceStep({ data, state: source, draftKey, session, card: true, ops });

  if (!source) {
    return (
      <CardSection title={project}>
        {data.error ? (
          <ReadError error={data.error} onRetry={ops?.retry} />
        ) : (
          <div aria-busy className="flex flex-col gap-2 py-1">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-control-sm" />
          </div>
        )}
      </CardSection>
    );
  }

  const uncommitted = [...source.staged, ...source.changes];
  const listed = uncommitted.length > 0 ? uncommitted : source.sinceBase;
  const added = listed.reduce((sum, file) => sum + file.added, 0);
  const removed = listed.reduce((sum, file) => sum + file.removed, 0);
  const name = data.naming ?? source.branch ?? source.rebasing?.branch ?? "…";
  return (
    <>
      <CardSection title={project}>
        {/* A watch that failed after its first read: the last read stays under it, as in Source [D30]. */}
        {data.error && !offline && <ReadError error={data.error} onRetry={ops?.retry} />}
        <Line icon={<Branch />} end={offline ? <Offline readAtMs={data.readAtMs ?? null} /> : (added > 0 || removed > 0) && <Counts added={added} removed={removed} />}>
          {name}
        </Line>
        {button && (
          <div className={cx("pt-1 pb-1.5", offline && "opacity-disabled")} inert={offline}>
            <ActionButton nowMs={nowMs} running={running} {...button} />
          </div>
        )}
      </CardSection>
      {prs.length > 0 && (
        <CardSection title="Pull requests">
          <div className={cx("flex flex-col", offline && "opacity-disabled")} inert={offline}>
            {prs.map((pr) => (
              <PrLine key={pr.number} pr={pr} onClick={() => onPr?.(pr.number)} />
            ))}
          </div>
        </CardSection>
      )}
      {dialogs}
    </>
  );
}
