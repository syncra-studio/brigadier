import { type ReactNode, useEffect, useState } from "react";

import { ChevronDown, ChevronDownUp, ChevronUpDown, Compare, Reload, Text } from "../icons";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "../components/menu";
import { Button } from "../components/button";
import { EmptyState } from "../components/empty-state";
import { Skeleton } from "../components/skeleton";
import { useKept } from "../thread/kept";
import { BriefStrip, noTurnWords } from "./brief";
import type { LineRange } from "./diff-view";
import { FileSection, type OpenIn } from "./file-section";
import { type Asking, actionable, Counts, RevertConfirm } from "./hunks";
import type { DiffComment, FileContents, HunkAction, RequestState, Review, ReviewFile, ReviewHunk, ReviewRequest, ReviewScope } from "./types";

/**
 * The Review tab (old ReviewTab), a main-area tab (D1032): a scope's diffs, each file under a sticky header, unified
 * by default with split and wrap. Unwired: what it shows and what it asks come through props (D388).
 */

export type ReviewTabProps = {
  scope: ReviewScope;
  onScope: (scope: ReviewScope) => void;
  /** The scope's file list with counts; null until it first arrives. */
  review: Review | null;
  /** Each file's contents as they arrive, after the list (D1036), or why one couldn't be read. */
  contents: ReadonlyMap<string, FileContents | { error: string }>;
  /** Why the list couldn't be read. The last list stays under it. */
  error: string | null;
  /** A read in flight: Refresh spins. */
  loading: boolean;
  /** The daemon is there: off, the diff stays and its actions wait (D30). */
  connected: boolean;
  onRefresh: () => void;
  /** Ask for a large file's contents, when it's opened (D1036). */
  onLoad: (path: string) => void;
  /** Stage, unstage and revert in flight or failed, by hunk id or file path. */
  /** Pending and refused actions by hunk id or path; a refused reason goes on the next read or the next success. */
  states: ReadonlyMap<string, RequestState>;
  /** Asked at once for Stage and Unstage, after its confirm for Revert. */
  onRequest: (request: ReviewRequest) => void;
  onOpenIn: (path: string, where: OpenIn) => void;
  comments: readonly DiffComment[];
  /** None where a comment couldn't reach the agent: no line picking then. */
  onComment?: (comment: DiffComment) => void;
  onRemoveComment: (id: string) => void;
  /** The comment being written, kept through a restart (D1195): its file, lines and words. */
  draft?: { path: string; range: LineRange; text: string } | null;
  onDraft?: (draft: { path: string; range: LineRange; text: string } | null) => void;
  /** The file it was opened on: shown open whatever else waits behind the one click. */
  target?: string;
  /** The one click between the brief and the diff (D1188): a "Show diff" row, or the file list, each file's name
   * opening its diff. Shown to the owner side by side (proposed); the app uses `files` meanwhile. */
  below?: "row" | "files";
};

const SCOPES: { value: ReviewScope; label: (base: string | null) => string }[] = [
  { value: "last", label: () => "Last turn" },
  { value: "uncommitted", label: () => "Uncommitted changes" },
  { value: "staged", label: () => "Staged Changes" },
  { value: "unstaged", label: () => "Changes" },
  { value: "branch", label: (base) => `Branch since ${base ?? "base"}` },
];

export function ReviewTab(props: ReviewTabProps) {
  const { scope, review, contents, error, loading, connected, target, below = "files" } = props;
  // How diffs are drawn, kept while the app runs (the old review options).
  const [wrap, setWrap] = useKept("review-wrap");
  const [split, setSplit] = useKept("review-split");
  // A large file starts folded until opened; any other only once folded.
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set(target ? [target] : []));
  // The diff behind the brief's one click; a commit's tab has no brief, so it shows at once.
  const [shown, setShown] = useState(scope === "commit" || target !== undefined);
  const folds = below === "files" && scope !== "commit";
  useEffect(() => {
    if (!target) return;
    setShown(true);
    setOpened((current) => new Set([...current, target]));
  }, [target]);
  const [asking, setAsking] = useState<Asking | null>(null);
  const files = review?.files ?? [];
  // The file a comment is being written on stays open, so its box comes back after a restart.
  const isCollapsed = (file: ReviewFile) => folded.has(file.path) || ((file.large || folds) && !opened.has(file.path) && props.draft?.path !== file.path);
  // Behind the "Show diff" row, every file counts as folded, and Expand all shows them.
  const hidden = below === "row" && !shown && !props.draft;
  const allCollapsed = files.length > 0 && (hidden || files.every(isCollapsed));
  const open = (shown: readonly ReviewFile[]) => {
    setOpened((current) => new Set([...current, ...shown.map((file) => file.path)]));
    setFolded((current) => new Set([...current].filter((path) => !shown.some((file) => file.path === path))));
  };
  // An opened large file without its contents asks for them: when opened, again when a refresh drops them, and on a
  // reconnect (D1036).
  useEffect(() => {
    if (loading || !connected) return;
    for (const file of files) if (file.large && opened.has(file.path) && !folded.has(file.path) && !contents.has(file.path)) props.onLoad(file.path);
  }, [review, contents, loading, connected, opened, folded]);
  const act = (action: HunkAction, file: ReviewFile, hunk: ReviewHunk | null) => {
    const request = { action, path: file.path, hunk: hunk?.id ?? null };
    if (action === "revert") setAsking({ request, file, hunk });
    else props.onRequest(request);
  };
  const label = SCOPES.find((entry) => entry.value === scope)?.label(review?.base ?? null);

  return (
    <div data-slot="review-tab" className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-control-lg shrink-0 items-center gap-1 border-b border-border px-2">
        {scope === "commit" ? (
          // A commit's tab is that commit: its subject and short id, no picker (D1041).
          <span className="flex min-w-0 items-center gap-1.5 px-1.5 text-sm text-muted-foreground">
            <span className="truncate">{review?.commit?.subject ?? "Commit"}</span>
            {review?.commit && <span className="shrink-0 font-mono text-xs">{review.commit.sha.slice(0, 7)}</span>}
          </span>
        ) : (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger className="flex h-control-xs cursor-pointer items-center gap-1 rounded-control px-1.5 text-sm text-muted-foreground hover:bg-fill hover:text-foreground focus-visible:focus-ring aria-expanded:bg-fill">
              {label}
              <ChevronDown className="size-icon-xs" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup value={scope} onValueChange={(value: ReviewScope) => props.onScope(value)}>
                {SCOPES.map((entry) => (
                  <DropdownMenuRadioItem key={entry.value} value={entry.value}>
                    {entry.label(review?.base ?? null)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {/* Elsewhere the brief says the size. */}
        {scope === "commit" && review && review.files.length > 0 && <Counts insertions={review.insertions} deletions={review.deletions} />}
        {!connected && <span className="px-1.5 text-xs text-muted-foreground">Reconnecting…</span>}
        <div className="flex-1" />
        <TooltipIconButton tooltip="Refresh" size="icon-sm" disabled={!connected} onClick={props.onRefresh}>
          <Reload className={cx(loading && "animate-spin motion-reduce:animate-none")} />
        </TooltipIconButton>
        <Toggle tooltip={wrap ? "Disable word wrap" : "Enable word wrap"} on={wrap} onClick={() => setWrap(!wrap)}>
          <Text />
        </Toggle>
        <TooltipIconButton
          tooltip={allCollapsed ? "Expand all diffs" : "Collapse all diffs"}
          size="icon-sm"
          disabled={files.length === 0}
          onClick={() => {
            setShown(true);
            if (allCollapsed) open(files);
            else setFolded(new Set(files.map((file) => file.path)));
          }}
        >
          {allCollapsed ? <ChevronUpDown /> : <ChevronDownUp />}
        </TooltipIconButton>
        <Toggle tooltip={split ? "Switch to unified diff" : "Switch to split diff"} on={split} onClick={() => setSplit(!split)}>
          <Compare />
        </Toggle>
      </div>
      <div data-slot="review-diffs" className="min-h-0 min-w-0 flex-1 overflow-auto">
        <ErrorLine size="sm" error={error} className="px-4 py-3" />
        {review && scope !== "commit" && !review.none && (
          <BriefStrip
            review={review}
            below={
              below === "row" &&
              !shown &&
              !props.draft &&
              review.files.length > 0 && (
                <Button size="xs" variant="soft" className="mt-1 self-start" onClick={() => setShown(true)}>
                  Show diff
                </Button>
              )
            }
          />
        )}
        {!review ? (
          !error && <ListLoading />
        ) : review.none ? (
          <EmptyState variant="centered" title={noTurnWords(review.none)} />
        ) : review.files.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No changes</p>
        ) : hidden ? null : (
          review.files.map((file) => (
            <FileSection
              key={file.path}
              file={file}
              contents={contents.get(file.path)}
              look={{ numbered: true, split, wrap, words: true }}
              collapsed={isCollapsed(file)}
              onToggle={() => (isCollapsed(file) ? open([file]) : setFolded((current) => new Set([...current, file.path])))}
              actions={actionable(scope)}
              connected={connected}
              states={props.states}
              onAction={act}
              onRetry={() => props.onLoad(file.path)}
              onOpenIn={props.onOpenIn}
              comments={props.comments.filter((comment) => comment.path === file.path)}
              onComment={props.onComment}
              onRemoveComment={props.onRemoveComment}
              draft={props.draft?.path === file.path ? props.draft : null}
              onDraft={props.onDraft && ((draft) => props.onDraft?.(draft && { path: file.path, ...draft }))}
            />
          ))
        )}
      </div>
      <RevertConfirm scope={scope} asking={asking} onClose={() => setAsking(null)} onConfirm={props.onRequest} />
    </div>
  );
}

function Toggle({ tooltip, on, onClick, children }: { tooltip: string; on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <TooltipIconButton tooltip={tooltip} size="icon-sm" pressed={on} className="aria-pressed:bg-muted aria-pressed:text-foreground" onClick={onClick}>
      {children}
    </TooltipIconButton>
  );
}

/** Before the first list arrives: three file headers' worth of grey. */
function ListLoading() {
  return (
    <div data-slot="review-loading" className="flex flex-col gap-3 p-3">
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-control-xs w-1/2" />
      ))}
    </div>
  );
}
