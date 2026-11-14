import { type ReactNode, useId, useState } from "react";

import { FileTypeIcon } from "../components/composer/attachments";
import { ComposerPill } from "../components/composer/composer";
import { copyWithToast } from "../components/copy-button";
import { cx } from "../components/cx";
import { viewImage } from "../components/image-viewer";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/menu";
import { TooltipIconButton } from "../components/icon-button";
import { useDaemon } from "../daemon";
import { Branch, ChevronDown, Copy } from "../icons";
import { PullRequestOpen } from "../landing/icons";
import { Offline } from "./source/branch";
import { ReadError, type SourceData, type SourceOps } from "./source/data";
import { Gone } from "./source/hero";
import { Counts, Line, Note, PrLine } from "./source/rows";
import { ago } from "../landing/pr-words";
import type { Pr } from "./types";

/** Sections folded or opened by hand, by key, for the app's lifetime: every session's card keeps them. */
const folds = new Map<string, boolean>();

/**
 * One of the card's parts, a hairline under it as the old card's [D1075, D1198]; `end` ends its title row. With `fold`
 * (its key), its title folds it as the old card's SummarySection [D200]: the chevron after it shows on hover while
 * open and stays, turned, while folded, with `count` after the title; a `count` that grows opens it again.
 */
export function CardSection({ title, end, fold, count, children }: { title?: ReactNode; end?: ReactNode; fold?: string; count?: number; children?: ReactNode }) {
  const body = useId();
  const [kept, setKept] = useState(() => (fold ? folds.get(fold) : undefined));
  const [was, setWas] = useState(count ?? 0);
  if (count !== undefined && count !== was) {
    setWas(count);
    if (count > was) setKept(false);
  }
  const folded = Boolean(fold && children && kept);
  const toggle = () => {
    if (fold) folds.set(fold, !folded);
    setKept(!folded);
  };
  return (
    <section
      data-folded={folded || undefined}
      className={cx("relative flex flex-col pb-2 after:absolute after:inset-x-5 after:bottom-0 after:h-px after:origin-bottom after:scale-y-50 after:bg-divider last:pb-0 last:after:hidden", folded && "pb-0.5")}
    >
      {(title || end) && (
        <header className="flex h-7 min-w-0 items-center gap-2 ps-5 pe-3.5 text-label text-muted-foreground">
          {fold && children ? (
            <button
              type="button"
              aria-expanded={!folded}
              aria-controls={body}
              onClick={toggle}
              className="group/fold -ms-1 inline-flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-control py-0.5 ps-1 pe-1 text-start transition-colors hover:text-foreground focus-visible:focus-ring"
            >
              <span className="min-w-0 truncate">{title}</span>
              {folded && count !== undefined && count > 0 && <span className="min-w-0 shrink truncate tabular-nums">· {count}</span>}
              <ChevronDown
                aria-hidden
                className={cx(
                  "size-icon-xs shrink-0 transition motion-reduce:transition-none",
                  folded ? "-rotate-90" : "opacity-0 group-hover/fold:opacity-100 group-focus-visible/fold:opacity-100",
                )}
              />
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate">{title}</span>
          )}
          {end && <div className="flex shrink-0 items-center gap-0.5">{end}</div>}
        </header>
      )}
      {children && (
        <div id={body} hidden={folded} className="flex min-w-0 flex-col gap-0.5 px-5">
          {children}
        </div>
      )}
    </section>
  );
}

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

/**
 * The summary card's git part, as the old card's [D64]: the project as a quiet title; the branch row, the composer's
 * picker pill opening its copies menu, never a switcher [D62, D72, D232], with the +/− counts opening Review at its end (no uncommitted count, D1209) [D1273]; one note
 * line; a hairline, then the session's pull requests in GitHub's state words and colours, folding as the old card's
 * Background section, its button and each row opening the Pull requests tab [D1017, D1116, D200, D202], then the
 * Workers section [D65]. Disconnected, "Offline · 14:32" takes
 * the counts' place and the rest dims [D30, D1206]. Without `ops` (the gallery) it moves nothing.
 */
export function GitCard({ data, nowMs, project = null, session = null, ops, onPr, onPrs, onReview, workers }: {
  data: SourceData;
  nowMs: number;
  project?: string | null;
  session?: string | null;
  ops?: SourceOps;
  onPr?: (pr: Pr) => void;
  /** The section's own button: the list of them, or the one [D200, D205]. */
  onPrs?: (prs: Pr[]) => void;
  onReview?: () => void;
  /** The session's Workers section, after the PRs [D65]. */
  workers?: ReactNode;
}) {
  const { source } = data;
  const offline = data.offline ?? false;
  // The watch's kept PRs [D1009], the session row's where the gallery has none.
  const { rows, projects } = useDaemon();
  const row = rows?.find((each) => each.id === session);
  const kept = data.kept ?? row?.prs ?? undefined;
  const prs = data.prs ?? kept?.prs ?? [];

  if (data.truth?.missing) {
    return (
      <CardSection title={project}>
        <div className="pb-2">
          <Gone data={data} onRestore={ops?.restore} />
        </div>
      </CardSection>
    );
  }

  // Shown only once its read is in (summaryReady), so it's drawn once whole; with no read, only why [D1307].
  if (!source) {
    return (
      <CardSection title={project}>
        {data.error && <ReadError error={data.error} onRetry={ops?.retry} />}
      </CardSection>
    );
  }

  const uncommitted = [...source.staged, ...source.changes];
  const listed = uncommitted.length > 0 ? uncommitted : source.sinceBase;
  const added = listed.reduce((sum, file) => sum + file.added, 0);
  const removed = listed.reduce((sum, file) => sum + file.removed, 0);
  const detached = data.truth?.detached;
  const name = source.branch ?? source.rebasing?.branch ?? (detached ? `Detached at ${detached}` : "…");
  const shared = data.share?.with;
  const note = noteOf(data);
  const first = prs.find((pr) => pr.state === "open") ?? prs[0];
  // Its start lines up with the title's; offline it can't open [D30].
  const pill = { "aria-label": `Branch: ${name}`, disabled: offline, className: "-ms-2 max-w-full" };
  // A session's branch is its own, in its worktree or the project's folder alike: its menu only copies [D62, D232].
  const copies: [string, string | null | undefined][] = [
    ["session id", session],
    ["session path", row?.folder],
    ["project path", projects?.find((each) => each.id === row?.project)?.folder],
    ["branch name", source.branch],
  ];
  return (
    <>
      <CardSection title={project}>
        {/* A watch that failed after its first read: the last read stays under it [D30]. */}
        {data.error && !offline && <ReadError error={data.error} onRetry={ops?.retry} />}
        <div className="flex min-w-0 items-center gap-2">
          {/* The composer's pickers' pill and menu [D72]. */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger render={<ComposerPill {...pill} />}>
              <span className="flex min-w-0 items-center gap-1">
                <Branch />
                <span className="truncate text-foreground">{name}</span>
                {/* Both cut, so the share always shows [D1082]. */}
                {shared && <span className="truncate">· shared with {shared}</span>}
                <ChevronDown className="size-icon-xs" />
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="start">
              {copies.map(([what, value]) => (
                <DropdownMenuItem key={what} onClick={() => value && copyWithToast(value, what)}>
                  <Copy />
                  Copy {what}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="flex-1" />
          {offline ? (
            <Offline readAtMs={data.readAtMs ?? null} />
          ) : (
            (added > 0 || removed > 0) && (
              <button type="button" aria-label="Review the changes" onClick={onReview} className="shrink-0 cursor-pointer rounded-control hover:underline focus-visible:focus-ring">
                <Counts added={added} removed={removed} />
              </button>
            )
          )}
        </div>
        {note && <Note text={note.text} warn={note.warn} />}
      </CardSection>
      {(first || kept?.error) && (
        // As the old card's Background section [D200]: its title folds it, its own button opens the Pull requests tab.
        <CardSection
          title="Pull requests"
          fold="pull-requests"
          count={prs.length}
          end={
            first && (
              <TooltipIconButton tooltip="Open pull requests" size="icon-xs" onClick={() => onPrs?.(prs)}>
                <PullRequestOpen />
              </TooltipIconButton>
            )
          }
        >
          <div className={cx("flex flex-col", offline && "opacity-disabled")} inert={offline}>
            {prs.map((pr) => (
              <PrLine key={`${pr.repo ?? ""}#${pr.number}`} pr={pr} onClick={() => onPr?.(pr)} />
            ))}
            {/* A watch read that failed: the last PRs stay above, with their age and why [D1009]. */}
            {kept?.error && <Note warn text={["Couldn't check", kept.okAt && ago(kept.okAt, nowMs), kept.error.split("\n")[0]].filter(Boolean).join(" · ")} />}
          </div>
        </CardSection>
      )}
      {workers}
    </>
  );
}

/** A sent file on the card, as `attach <id> list` gives it. */
export type CardFile = { id: string; name: string; label?: string | null; mime: string; url: string };

/**
 * The old card's "Attachments": the files the session's messages carried, each opening with one click, an image in
 * the viewer with the others beside it [D1048, D1274]. A name already taken gets " (2)" after it, as the old rows.
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
    <CardSection title="Attachments">
      {files.map((file) => (
        <Line
          key={file.id}
          icon={file.mime.startsWith("image/") ? <img src={file.url} alt="" draggable={false} className="size-icon-md rounded-xs object-cover" /> : <FileTypeIcon name={file.name} />}
          onClick={() => (file.mime.startsWith("image/") ? viewImage(gallery, images.indexOf(file)) : onOpen(file, labels.get(file.id)!))}
        >
          {labels.get(file.id)}
        </Line>
      ))}
    </CardSection>
  );
}
