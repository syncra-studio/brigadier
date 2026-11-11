import { type ReactNode, useRef } from "react";

import { cx } from "../components/cx";
import { Skeleton } from "../components/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { ArrowUp, Branch, ChevronDown, ChevronRight } from "../icons";
import { ArrowDown } from "../icons/sidebar";
import { GitControl } from "./control";
import { Offline } from "./source/branch";
import { ReadError, type SourceData, type SourceOps } from "./source/data";
import { Gone } from "./source/hero";
import { Counts, Line, Note, PrLine } from "./source/rows";
import { useSourceStep } from "./source/step";
import { plural } from "./words";
import { useBranchPicker } from "./branch-picker";

/** One of the card's parts, a hairline under it as the old card's [D1075, D1198]; `end` ends its title row. */
function CardSection({ title, end, children }: { title?: ReactNode; end?: ReactNode; children: ReactNode }) {
  return (
    <section className="relative flex flex-col pb-2 after:absolute after:inset-x-5 after:bottom-0 after:h-px after:origin-bottom after:scale-y-50 after:bg-divider last:pb-0 last:after:hidden">
      {(title || end) && (
        <header className="flex h-7 min-w-0 items-center gap-2 ps-5 pe-3.5 text-label text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {end}
        </header>
      )}
      <div className="flex min-w-0 flex-col gap-0.5 px-5">{children}</div>
    </section>
  );
}

/**
 * The card's one note, every fact it has joined in one line [D1198]: the checkout on another branch than its record's
 * [D1187], waiting for the turn [D1208], the base moved [D1282], merged on this machine, the base behind its own
 * upstream [D1193].
 */
function noteOf(data: SourceData): { text: string; warn: boolean } | null {
  const { step, truth, freshness } = data;
  const base = step?.base ?? "main";
  const said: [string, boolean][] = [];
  if (truth?.mismatch && !truth.detached) said.push([`On ${truth.branch}, not ${truth.recordedBranch}`, true]);
  if (data.agentWorking) said.push(["Waits for the turn to finish", false]);
  if (step?.moved && step.landedAtMs === null) said.push([`${base} moved ${plural(step.moved, "commit")}: catch up first`, true]);
  if (step?.landedAtMs) said.push([`Merged into ${base} on this machine`, false]);
  if (freshness?.behind && freshness.upstream) said.push([`${freshness.name} is ${freshness.behind} behind ${freshness.upstream}`, false]);
  return said.length ? { text: said.map(([text]) => text).join(" · "), warn: said.some(([, warn]) => warn) } : null;
}

/**
 * The summary card's git part, The mix [D1186, D1198], with its control [D1278]: the project as a quiet title with the
 * control at its end; the branch row, a picker opening its quick pick, ↑n ↓n when not zero and the +/− counts opening
 * Review (no uncommitted count, D1209) [D1273]; one note line; a hairline, then the branch's pull requests in the old
 * card's icons, words and colours, the title and each row opening the Pull requests tab [D1017, D1116]. The counts,
 * the PR rows and the control change together from one read [D1263]. Disconnected, "Offline · 14:32" takes the
 * counts' place and the rest dims [D30, D1206]. Without `ops` (the gallery) it moves nothing.
 */
export function GitCard({ data, nowMs, project = null, session = null, ops, onPr, onReview }: {
  data: SourceData;
  nowMs: number;
  project?: string | null;
  session?: string | null;
  ops?: SourceOps;
  onPr?: (number: number) => void;
  onReview?: () => void;
}) {
  const { source, step } = data;
  const offline = data.offline ?? false;
  const control = useSourceStep({ data, session });
  const prs = control.prs;
  const branchRow = useRef<HTMLDivElement>(null);
  const { open, pickers } = useBranchPicker({ data, ops, base: step?.base ?? null, nowMs, anchor: branchRow });

  if (data.truth?.missing) {
    return (
      <CardSection title={project}>
        <div className="pb-2">
          <Gone data={data} onRestore={ops?.restore} />
        </div>
      </CardSection>
    );
  }

  // Nothing kept: the skeleton until the read and its step are both in, so it's drawn once whole [D1307].
  if (!source || (data.stepRead === false && !data.error && !offline)) {
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
  const detached = data.truth?.detached;
  const name = data.naming ?? source.branch ?? source.rebasing?.branch ?? (detached ? `Detached at ${detached}` : "…");
  const shared = data.share?.with;
  const note = noteOf(data);
  const first = prs.find((pr) => pr.state === "open") ?? prs[0];
  return (
    <>
      <CardSection title={project} end={step && <GitControl step={step} off={control.off} running={control.running} onRun={control.run} />}>
        {/* A watch that failed after its first read: the last read stays under it [D30]. */}
        {data.error && !offline && <ReadError error={data.error} onRetry={ops?.retry} />}
        <div ref={branchRow} className="flex min-w-0 items-center gap-2">
          <Line icon={<Branch />} {...(!offline && { onClick: () => open("branch") })}>
            <span className="inline-flex max-w-full items-center gap-1 align-middle">
              <span className="truncate">{name}</span>
              {/* Both cut, so the share always shows [D1082]. */}
              {shared && <span className="truncate text-muted-foreground">· shared with {shared}</span>}
              {!offline && <ChevronDown className="size-icon-xs shrink-0 text-muted-foreground" />}
            </span>
          </Line>
          {offline ? (
            <Offline readAtMs={data.readAtMs ?? null} />
          ) : (
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
              {source.behind > 0 && (
                <span className="flex items-center text-warning">
                  <ArrowDown className="size-icon-xs" />
                  {source.behind}
                </span>
              )}
              {source.ahead > 0 && (
                <span className="flex items-center">
                  <ArrowUp className="size-icon-xs" />
                  {source.ahead}
                </span>
              )}
              {(added > 0 || removed > 0) && (
                <button type="button" aria-label="Review the changes" onClick={onReview} className="cursor-pointer rounded-control hover:underline focus-visible:focus-ring">
                  <Counts added={added} removed={removed} />
                </button>
              )}
            </span>
          )}
        </div>
        {note && <Note text={note.text} warn={note.warn} />}
      </CardSection>
      {first && (
        <CardSection
          title={
            <Tooltip>
              <TooltipTrigger render={<button type="button" onClick={() => onPr?.(first.number)} className="inline-flex cursor-pointer items-center gap-0.5 rounded-control hover:text-foreground focus-visible:focus-ring" />}>
                Pull requests
                <ChevronRight className="size-icon-xs" />
              </TooltipTrigger>
              <TooltipContent>Opens the PR tab</TooltipContent>
            </Tooltip>
          }
        >
          <div className={cx("flex flex-col", offline && "opacity-disabled")} inert={offline}>
            {prs.map((pr) => (
              <PrLine key={pr.number} pr={pr} onClick={() => onPr?.(pr.number)} />
            ))}
          </div>
        </CardSection>
      )}
      {pickers}
      {control.dialogs}
    </>
  );
}
