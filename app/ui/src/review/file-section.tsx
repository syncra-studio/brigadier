import { type ReactNode, useCallback, useMemo, useState } from "react";

import { ChevronDown, ChevronRight, ExternalLink, FolderOpen, Folders, Spinner } from "../icons";
import { FileIcon } from "../icons/file-types";
import { Button } from "../components/button";
import { CopyButton } from "../components/copy-button";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/menu";
import { CommentBox, CommentNote } from "./comments";
import { type DiffLook, type DiffNote, DiffView, type LineRange } from "./diff-view";
import { Actions, Counts, HunkBar } from "./hunks";
import type { DiffComment, FileContents, HunkAction, RequestState, ReviewFile, ReviewHunk } from "./types";

/** Where Open in sends a file: a file tab, its default app, or Finder. */
export type OpenIn = "tab" | "app" | "finder";

/** What one file's section is told and can ask (ReviewTab passes it on). */
export type FileProps = {
  file: ReviewFile;
  /** Its contents once they've arrived, or why they couldn't be read. */
  contents: FileContents | { error: string } | undefined;
  look: DiffLook;
  collapsed: boolean;
  onToggle: () => void;
  /** Stage and Revert, here and on its hunks (none in Branch since base). */
  actions: boolean;
  /** Off while the daemon is away. */
  connected: boolean;
  states: ReadonlyMap<string, RequestState>;
  onAction: (action: HunkAction, file: ReviewFile, hunk: ReviewHunk | null) => void;
  /** Ask for its contents again, after a failed read. */
  onRetry: () => void;
  onOpenIn: (path: string, where: OpenIn) => void;
  comments: readonly DiffComment[];
  /** None where a comment couldn't reach the agent: no line picking then. */
  onComment?: (comment: DiffComment) => void;
  onRemoveComment: (id: string) => void;
};

/** A changed file's "Open in" menu (old OpenInMenu): a file tab, its default app, or Finder. */
function OpenInMenu({ file, onOpenIn }: { file: ReviewFile; onOpenIn: FileProps["onOpenIn"] }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={<TooltipIconButton tooltip="Open in" size="icon-xs" disabled={file.status === "deleted"} />}>
        <ExternalLink />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onOpenIn(file.path, "tab")}>
          <Folders />
          File tab
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onOpenIn(file.path, "app")}>
          <ExternalLink />
          Default app
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onOpenIn(file.path, "finder")}>
          <FolderOpen />
          Finder
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One file's diff under its sticky header: icon, path, counts, on hover copy, Open in and fold, then Revert and Stage. */
export function FileSection(props: FileProps) {
  const { file, collapsed, onToggle, actions, connected, states, onAction } = props;
  const state = states.get(file.path);
  return (
    <section data-slot="review-file" data-path={file.path}>
      <header className="group/file sticky top-0 z-10 flex h-control-lg items-center gap-2 border-b border-border bg-background px-3 text-sm">
        <FileIcon name={file.path} />
        <span className="min-w-0 truncate text-foreground" title={file.path}>
          {file.from ? `${file.from} → ${file.path}` : file.path}
        </span>
        {file.binary ? <span className="text-xs text-muted-foreground">binary</span> : <Counts insertions={file.insertions} deletions={file.deletions} />}
        <span className="flex items-center opacity-0 transition-opacity group-hover/file:opacity-100 group-focus-within/file:opacity-100">
          <CopyButton text={file.path} tooltip="Copy path" size="icon-xs" />
          <OpenInMenu file={file} onOpenIn={props.onOpenIn} />
          <TooltipIconButton tooltip="Toggle file diff" size="icon-xs" aria-expanded={!collapsed} onClick={onToggle}>
            {collapsed ? <ChevronRight /> : <ChevronDown />}
          </TooltipIconButton>
        </span>
        <span className="flex-1" />
        {actions && (
          <>
            <ErrorLine error={state && "error" in state ? state.error : null} className="min-w-0 truncate" />
            <Actions staged={file.staged} state={state} disabled={!connected} onAction={(action) => onAction(action, file, null)} />
          </>
        )}
      </header>
      {!collapsed && <FileBody {...props} />}
    </section>
  );
}

const muted = (text: ReactNode) => <p className="px-3 py-2 text-sm text-muted-foreground">{text}</p>;

/** What sits under a line: a hunk's bar, a waiting comment, or the box being written. */
type Note = { kind: "hunk"; hunk: ReviewHunk } | { kind: "comment"; comment: DiffComment } | { kind: "box"; range: LineRange };

function FileBody({ file, contents, look, actions, connected, states, onAction, onRetry, comments, onComment, onRemoveComment }: FileProps) {
  const [draft, setDraft] = useState<LineRange | null>(null);
  // A pick across both sides keeps its end's line: a comment's numbers are one side's.
  const pick = useCallback((range: LineRange) => setDraft(range.endSide && range.endSide !== range.side ? { start: range.end, end: range.end, side: range.endSide } : range), []);
  const sides = contents && "hunks" in contents ? contents : null;
  const notes = useMemo(() => {
    if (!sides) return [];
    const all: DiffNote<Note>[] = [];
    // A hunk's bar goes under the unchanged line just above its first change; one changing line 1 gets it above the diff.
    if (actions) for (const hunk of sides.hunks) if (hunk.leading > 0) all.push({ side: "additions", lineNumber: hunk.newStart + hunk.leading - 1, metadata: { kind: "hunk", hunk } });
    for (const comment of comments) all.push({ side: comment.side, lineNumber: comment.end, metadata: { kind: "comment", comment } });
    if (draft) all.push({ side: draft.endSide ?? draft.side ?? "additions", lineNumber: draft.end, metadata: { kind: "box", range: draft } });
    return all;
  }, [sides, actions, comments, draft]);
  if (file.binary) return muted("Binary file not shown");
  if (contents && "error" in contents) {
    return (
      <ErrorLine
        size="sm"
        error={`Couldn't read this diff: ${contents.error}`}
        className="px-3 py-2"
        actions={
          <Button variant="link-blue" size="inline" disabled={!connected} onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  }
  // The list came first; its contents follow (D1036).
  if (!sides) {
    return (
      <p className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
        <Spinner className="size-icon-sm motion-safe:animate-spin" />
        Loading the diff…
      </p>
    );
  }
  if (sides.before === sides.after) return muted("No content changes");
  const hunkBar = (hunk: ReviewHunk) => (
    <HunkBar key={hunk.id} hunk={hunk} state={states.get(hunk.id)} disabled={!connected} onAction={(action) => onAction(action, file, hunk)} />
  );
  const sideLines = (side: "additions" | "deletions") => (side === "additions" ? sides.after : sides.before).split("\n");
  const render = ({ metadata }: DiffNote<Note>) =>
    metadata.kind === "hunk" ? (
      hunkBar(metadata.hunk)
    ) : metadata.kind === "comment" ? (
      <CommentNote comment={metadata.comment} onRemove={() => onRemoveComment(metadata.comment.id)} />
    ) : (
      <CommentBox
        start={Math.min(metadata.range.start, metadata.range.end)}
        end={Math.max(metadata.range.start, metadata.range.end)}
        onCancel={() => setDraft(null)}
        onSubmit={(text) => {
          const side = metadata.range.side ?? "additions";
          const start = Math.min(metadata.range.start, metadata.range.end);
          const end = Math.max(metadata.range.start, metadata.range.end);
          onComment?.({ id: crypto.randomUUID(), path: file.path, side, start, end, excerpt: (sideLines(side)[start - 1] ?? "").trim(), text });
          setDraft(null);
        }}
      />
    );
  return (
    <>
      {actions && sides.hunks.filter((hunk) => hunk.leading === 0).map(hunkBar)}
      <DiffView<Note>
        source={{ kind: "sides", path: file.path, before: sides.before, after: sides.after }}
        look={look}
        annotations={notes}
        renderAnnotation={render}
        onGutterClick={onComment && pick}
        onSelect={onComment && pick}
        selected={draft}
      />
    </>
  );
}
