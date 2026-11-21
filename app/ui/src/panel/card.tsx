import { type ReactNode, useId, useRef, useState } from "react";

import { FileTypeIcon } from "../components/composer/attachments";
import { copyWithToast } from "../components/copy-button";
import { cx } from "../components/cx";
import { viewImage } from "../components/image-viewer";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/menu";
import { showToast } from "../components/toast";
import { errorText, run } from "../onboarding/api";
import { openPrDialog } from "./create-pr";
import { TooltipIconButton } from "../components/icon-button";
import { useDaemon } from "../daemon";
import { Branch, CheckCircle, ChevronDown, Dot, DotsHorizontal, Spinner, Warning, X } from "../icons";
import { Offline } from "./source/branch";
import type { SourceData, SourceOps } from "./source/data";
import { Counts, Line, Rows } from "./source/rows";
import { useBranchPicker } from "./branch-picker";
import type { KeptPrs, Pr } from "./types";

/** Sections folded by hand, by key, for every session's card, kept across restarts [D138]. */
const FOLDS = "summary-folds";
const folds: Record<string, boolean> = JSON.parse(localStorage.getItem(FOLDS) ?? "{}");

/**
 * One of the card's parts, a section [D138]: its muted title folds it, a chevron after it on hover while open
 * and turned while folded, with `count` after the title then; a hairline between sections, 20 in from the card's
 * edges. `end` ends its title row (Sources' +, Background's history).
 */
export function CardSection({ title, fold, end, count, children }: { title: ReactNode; fold: string; end?: ReactNode; count?: number; children?: ReactNode }) {
  const body = useId();
  const [folded, setFolded] = useState(() => folds[fold] ?? false);
  const toggle = () => {
    folds[fold] = !folded;
    localStorage.setItem(FOLDS, JSON.stringify(folds));
    setFolded(!folded);
  };
  return (
    <section className="relative flex flex-col py-2 first:pt-0 last:pb-0 not-first:before:absolute not-first:before:inset-x-2 not-first:before:top-0 not-first:before:h-px not-first:before:bg-divider">
      <header className="mb-1 flex h-6 min-w-0 items-center gap-2 ps-2 pe-1 text-label text-muted-foreground">
        <button
          type="button"
          aria-expanded={!folded}
          aria-controls={body}
          onClick={toggle}
          className="group/fold inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-sm text-start transition-colors hover:text-foreground focus-visible:focus-ring"
        >
          <span className="min-w-0 truncate">{title}</span>
          {folded && count !== undefined && count > 0 && <span className="shrink-0 tabular-nums">· {count}</span>}
          <ChevronDown
            aria-hidden
            className={cx(
              "size-icon-xs shrink-0 transition motion-reduce:transition-none",
              folded ? "-rotate-90" : "opacity-0 group-hover/fold:opacity-100 group-focus-visible/fold:opacity-100",
            )}
          />
        </button>
        <span className="flex-1" />
        {end && <div className="flex shrink-0 items-center gap-0.5">{end}</div>}
      </header>
      <div id={body} hidden={folded} className="flex min-w-0 flex-col">
        {children}
      </div>
    </section>
  );
}

/** A row's "…": its menu over the row's end on hover [D141]. */
export function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={<TooltipIconButton tooltip={label} size="icon-xs" className="text-muted-foreground hover:text-foreground" />}>
        <DotsHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A warning on the card, as a row: the checkout's truth, the base behind, a read that failed [D149]. */
export const WarnLine = ({ text, end }: { text: string; end?: ReactNode }) => (
  <Line icon={<Warning />} end={end} title={text} className="text-warning">
    {text}
  </Line>
);

/**
 * The card's one note, every fact it has joined in one line [D1198]: the checkout on another branch than its record's
 * [D1187], the base behind its own upstream [D1193].
 */
function noteOf(data: SourceData): { text: string; warn: boolean } | null {
  const { truth, freshness } = data;
  const said: [string, boolean][] = [];
  if (truth?.mismatch && !truth.detached) said.push([`On ${truth.branch}, not ${truth.recordedBranch}`, true]);
  if (freshness?.behind && freshness.upstream) said.push([`${freshness.name} is ${freshness.behind} behind ${freshness.upstream}`, false]);
  return said.length ? { text: said.map(([text]) => text).join(" · "), warn: said.some(([, warn]) => warn) } : null;
}

/** The card has something whole to show: the checkout's read, or why it can't read. Until then it isn't drawn at all. */
export const summaryReady = (data: SourceData) => Boolean(data.truth?.missing || data.error || data.source);

const TRY = "shrink-0 cursor-pointer rounded-sm text-link hover:underline focus-visible:focus-ring disabled:cursor-default disabled:opacity-disabled";

/**
 * The card's Changes section [D140 D141 D148 D149]: one row, "project · branch" with its +/− counts,
 * opening Review; its "…" copies the branch and, in your own folder, switches it (the composer's quick pick). A gone
 * folder, a read that failed and the checkout's notes are rows under it; disconnected, "Offline · 14:32" takes the
 * counts' place [D30, D1206]. Without `ops` (the gallery) it moves nothing. A session's branch with a remote also has
 * Compare branch, Create pull request, Attach pull request and View PR [D168 D169].
 */
export function ChangesCard({
  data,
  nowMs,
  project = null,
  ops,
  onReview,
  owner,
  prs = [],
  onViewPr,
}: {
  data: SourceData;
  nowMs: number;
  project?: string | null;
  ops?: SourceOps;
  onReview?: () => void;
  owner?: string;
  prs?: readonly Pr[];
  onViewPr?: (pr: Pr) => void;
}) {
  const { source } = data;
  const offline = data.offline ?? false;
  const branchRow = useRef<HTMLDivElement>(null);
  const { folder, open, pickers } = useBranchPicker({ data, ops, nowMs, anchor: branchRow, trigger: branchRow });

  if (data.truth?.missing) {
    const restoring = data.restoring ?? false;
    return (
      <CardSection title="Changes" fold="changes">
        <WarnLine
          text="This session's folder is gone"
          end={
            data.truth.restorable ? (
              <button type="button" disabled={restoring || offline} onClick={ops?.restore} className={TRY}>
                {restoring ? "Restoring…" : data.restoreError ? "Try again" : "Restore"}
              </button>
            ) : (
              "Can't restore"
            )
          }
        />
        {data.restoreError && <WarnLine text={data.restoreError} />}
      </CardSection>
    );
  }

  const failed = data.error && !offline && (
    <WarnLine
      text={`Couldn't read: ${data.error}`}
      end={
        <button type="button" onClick={ops?.retry} className={TRY}>
          Try again
        </button>
      }
    />
  );
  // Shown only once its read is in (summaryReady), so it's drawn once whole; with no read, only why [D1307].
  if (!source) {
    return (
      <CardSection title="Changes" fold="changes">
        {failed}
      </CardSection>
    );
  }

  const uncommitted = [...source.staged, ...source.changes];
  const listed = uncommitted.length > 0 ? uncommitted : source.sinceBase;
  const added = listed.reduce((sum, file) => sum + file.added, 0);
  const removed = listed.reduce((sum, file) => sum + file.removed, 0);
  const detached = data.truth?.detached;
  const branch = data.naming ?? source.branch ?? source.rebasing?.branch ?? (detached ? `Detached at ${detached}` : "…");
  const note = noteOf(data);
  // The branch's own open PRs.
  const mine = prs.filter((pr) => pr.state === "open" && (!pr.branch || pr.branch === source.branch));
  const end = offline ? <Offline readAtMs={data.readAtMs ?? null} /> : (added > 0 || removed > 0) && <Counts added={added} removed={removed} />;
  return (
    <CardSection title="Changes" fold="changes">
      {failed}
      <div ref={branchRow} className={cx(offline && "opacity-disabled")} inert={offline}>
        <Line
          icon={<Branch />}
          end={end}
          onClick={onReview}
          action={
            <RowMenu label="Branch actions">
              <DropdownMenuItem disabled={!source.branch} onClick={() => source.branch && copyWithToast(source.branch, "branch name")}>
                Copy branch
              </DropdownMenuItem>
              {folder && <DropdownMenuItem onClick={() => open("branch")}>Switch branch</DropdownMenuItem>}
              {owner && source.remote && (
                <>
                  <DropdownMenuSeparator />
                  {source.branch && (
                    <DropdownMenuItem
                      onClick={() =>
                        run(["host", owner, "compare", "", source.branch!])
                          .then((reply) => window.brigadier?.openLink(String(reply.url)))
                          .catch((cause) => showToast(errorText(cause), { tone: "error" }))
                      }
                    >
                      Compare branch
                    </DropdownMenuItem>
                  )}
                  {!mine.length && <DropdownMenuItem onClick={() => openPrDialog({ kind: "create", owner, repo: project, branch: source.branch ?? null, changed: uncommitted.length > 0 })}>Create pull request</DropdownMenuItem>}
                  <DropdownMenuItem onClick={() => openPrDialog({ kind: "attach", owner })}>Attach pull request</DropdownMenuItem>
                  {mine.length > 0 && <DropdownMenuItem onClick={() => onViewPr?.(mine[0]!)}>{mine.length > 1 ? "View PRs" : "View PR"}</DropdownMenuItem>}
                </>
              )}
            </RowMenu>
          }
        >
          {project ? `${project} · ${branch}` : branch}
        </Line>
      </div>
      {note && (note.warn ? <WarnLine text={note.text} /> : <Line title={note.text} className="text-muted-foreground">{note.text}</Line>)}
      {pickers}
    </CardSection>
  );
}

/** A repo a folder chat changed, as `source <id> repos` gives it [D494]. */
export type TouchedRepo = { name: string; branch: string | null; added: number; removed: number; kept: KeptPrs | null };

/**
 * A folder chat's Changes [D494, D544, D151]: a row per repo it changed, "repo · branch" and its +/− counts, opening
 * Review on that repo. A repo claimed and never changed isn't shown.
 */
export function FolderChanges({ repos, onReview }: { repos: TouchedRepo[]; onReview: (repo: string) => void }) {
  if (repos.length === 0) return null;
  return (
    <CardSection title="Changes" fold="changes">
      {repos.map((repo) => (
        <Line key={repo.name} icon={<Branch />} end={<Counts added={repo.added} removed={repo.removed} />} onClick={() => onReview(repo.name)}>
          {repo.name} · {repo.branch ?? "…"}
        </Line>
      ))}
    </CardSection>
  );
}

/** A plan step's mark by its status, as the CLIs write it: done, under way, given up, or still to do. */
const STEP: Record<string, ReactNode> = {
  completed: <CheckCircle />,
  in_progress: <Spinner className="animate-spin motion-reduce:animate-none" />,
  cancelled: <X />,
};

/**
 * The Plan, from the agent's own to-do list as its CLI last wrote it (Claude Code's TodoWrite, OpenCode's
 * todowrite, Codex's update_plan) [D144]: a row a step, done ones muted. Nothing when it wrote none.
 */
export function PlanCard({ owner }: { owner: string }) {
  const plan = useDaemon().rows?.find((row) => row.id === owner)?.plan;
  if (!plan?.length) return null;
  return (
    <CardSection title="Plan" fold="plan" count={plan.length}>
      <Rows items={plan}>
        {(step, index) => (
          <Line key={index} icon={STEP[step.status] ?? <Dot />} title={step.text} className={cx(step.status !== "in_progress" && step.status !== "pending" && "text-muted-foreground")}>
            {step.text}
          </Line>
        )}
      </Rows>
    </CardSection>
  );
}

/** A sent file on the card, as `attach <id> list` gives it. */
export type CardFile = { id: string; name: string; label?: string | null; mime: string; url: string };

/**
 * The old card's "Attachments": the files the session's messages carried, each opening with one click, an image in
 * the viewer with the others beside it [D1048, D1274, D151]. A name already taken gets " (2)" after it, as the old rows.
 */
export function AttachmentsCard({ files, onOpen }: { files: readonly CardFile[]; onOpen: (file: CardFile, label: string) => void }) {
  if (files.length === 0) return null;
  const taken = new Set<string>();
  const labels = new Map(
    files.map((file) => {
      const name = file.label ?? (file.name === "Pasted text.txt" ? "Pasted text" : file.name);
      let each = name;
      for (let copy = 2; taken.has(each); copy += 1) each = `${name} (${copy})`;
      taken.add(each);
      return [file.id, each];
    }),
  );
  const images = files.filter((file) => file.mime.startsWith("image/"));
  const gallery = images.map((file) => ({ name: labels.get(file.id)!, url: file.url }));
  return (
    <CardSection title="Attachments" fold="attachments" count={files.length}>
      <Rows items={files}>
        {(file) => (
          <Line
            key={file.id}
            icon={file.mime.startsWith("image/") ? <img src={file.url} alt="" draggable={false} className="size-4 rounded-xs object-cover" /> : <FileTypeIcon name={file.name} />}
            onClick={() => (file.mime.startsWith("image/") ? viewImage(gallery, images.indexOf(file)) : onOpen(file, labels.get(file.id)!))}
          >
            {labels.get(file.id)}
          </Line>
        )}
      </Rows>
    </CardSection>
  );
}
