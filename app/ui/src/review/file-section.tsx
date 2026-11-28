import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { couldntReadDiff, REVIEW_WORDS } from "../../../shared/words";
import { ChevronDown, ChevronRight, ExternalLink, FolderOpen, Folders, Spinner } from "../icons";
import { FileIcon } from "../icons/file-types";
import { Button } from "../components/button";
import { CopyButton } from "../components/copy-button";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/menu";
import { CommentBox, CommentNote } from "./comments";
import { type DiffLook, type DiffNote, DiffView, type LineRange, type Sides } from "./diff-view";
import { fileFact } from "./brief";
import { Counts } from "./hunks";
import type { DiffComment, FileContents, PatchContents, ReviewFile } from "./types";

/** Where Open in sends a file: a file tab, its default app, or Finder. */
export type OpenIn = "tab" | "app" | "finder";

/** What one file's section is told and can ask (ReviewTab passes it on). */
export type FileProps = {
  file: ReviewFile;
  /** Its contents once they've arrived, or why they couldn't be read. */
  contents: FileContents | PatchContents | { error: string } | undefined;
  look: DiffLook;
  collapsed: boolean;
  onToggle: () => void;
  /** Off while the daemon is away. */
  connected: boolean;
  /** Ask for its contents again, after a failed read. */
  onRetry: () => void;
  /** None where the file isn't in a checkout here (a PR's): no Open in then. */
  onOpenIn?: (path: string, where: OpenIn) => void;
  comments: readonly DiffComment[];
  /** None where a comment couldn't reach the agent: no line picking then. A promise keeps the box open until it lands. */
  onComment?: (comment: DiffComment) => void | Promise<void>;
  onRemoveComment: (id: string) => void;
  /** The comment being written on this file, kept through a restart (D1195), and where its changes go. */
  draft?: { range: LineRange; text: string } | null;
  onDraft?: (draft: { range: LineRange; text: string } | null) => void;
  /** A host's patch's file whole, read when its unchanged lines are first opened [D262]. */
  onSides?: () => Promise<Sides>;
  /** GitHub's file card (a PR's Files changed) [D262]: bordered, the fold chevron first and always shown. */
  card?: boolean;
  /** A PR's own: its review threads under their lines, what sits over the diff, and its header's end [D166]. */
  notes?: readonly { side: "additions" | "deletions"; line: number; key: string; node: ReactNode }[];
  above?: ReactNode;
  end?: ReactNode;
};

/** A changed file's "Open in" menu (old OpenInMenu): a file tab, its default app, or Finder. */
function OpenInMenu({ file, onOpenIn }: { file: ReviewFile; onOpenIn: NonNullable<FileProps["onOpenIn"]> }) {
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

/** One file's diff under its sticky header: icon, path, counts, and on hover copy, Open in and fold. */
export function FileSection(props: FileProps) {
  const { file, collapsed, onToggle, card } = props;
  const fold = (
    <TooltipIconButton tooltip="Toggle file diff" size="icon-xs" aria-expanded={!collapsed} onClick={onToggle}>
      {collapsed ? <ChevronRight /> : <ChevronDown />}
    </TooltipIconButton>
  );
  return (
    // overflow-clip, not hidden: the header stays sticky in the list's scroll.
    <section
      data-slot="review-file"
      data-path={file.path}
      className={card ? cx("overflow-clip rounded-surface border border-border", !collapsed && "drawn-when-seen") : undefined}
    >
      <header className={cx("group/file sticky top-0 z-10 flex h-control-lg items-center gap-2 border-b border-border px-3 text-sm", card ? "bg-card" : "bg-background", card && collapsed && "border-b-0")}>
        {card ? fold : <FileIcon name={file.path} />}
        {/* The file list opens a file's diff: its name is the click (D1188). */}
        <button type="button" aria-expanded={!collapsed} onClick={onToggle} className="min-w-0 cursor-pointer truncate rounded-control text-left text-foreground focus-visible:focus-ring" title={file.path}>
          {file.from ? `${file.from} → ${file.path}` : file.path}
        </button>
        {file.binary ? <span className="text-xs text-muted-foreground">{REVIEW_WORDS.binary}</span> : <Counts insertions={file.insertions} deletions={file.deletions} />}
        {file.flag && <span className="shrink-0 text-xs text-warning">{fileFact(file.flag)}</span>}
        <span className="flex items-center opacity-0 transition-opacity group-hover/file:opacity-100 group-focus-within/file:opacity-100">
          <CopyButton text={file.path} tooltip="Copy path" size="icon-xs" />
          {props.onOpenIn && <OpenInMenu file={file} onOpenIn={props.onOpenIn} />}
          {!card && fold}
        </span>
        {props.end}
      </header>
      {!collapsed && props.above}
      {!collapsed && <FileBody {...props} />}
    </section>
  );
}

const muted = (text: ReactNode) => <p className="px-3 py-2 text-sm text-muted-foreground">{text}</p>;

/** What sits under a line: a waiting comment, or the box being written. */
type Note = { kind: "comment"; comment: DiffComment } | { kind: "box"; range: LineRange } | { kind: "node"; node: ReactNode };

function FileBody({ file, contents, look, connected, onRetry, comments, onComment, onRemoveComment, draft: kept, onDraft, onSides, notes: extra }: FileProps) {
  const [draft, setRange] = useState<LineRange | null>(kept?.range ?? null);
  const setDraft = (range: LineRange | null) => {
    setRange(range);
    onDraft?.(range && { range, text: "" });
  };
  // Kept from before a restart, it opens again once it arrives.
  useEffect(() => {
    if (kept && !draft) setRange(kept.range);
  }, [kept?.range.start, kept?.range.end]);
  // A pick across both sides keeps its end's line: a comment's numbers are one side's.
  const pick = useCallback((range: LineRange) => setDraft(range.endSide && range.endSide !== range.side ? { start: range.end, end: range.end, side: range.endSide } : range), [onDraft]);
  const sides = contents && "hunks" in contents ? contents : null;
  const patch = contents && "patch" in contents ? contents.patch : null;
  // Kept while its patch is: the engine reads it once, when a fold is first opened.
  const whole = useMemo(() => onSides && (() => onSides()), [patch]);
  const notes = useMemo(() => {
    if (!sides && !patch) return [];
    const all: DiffNote<Note>[] = [];
    for (const comment of comments) all.push({ side: comment.side, lineNumber: comment.end, metadata: { kind: "comment", comment } });
    for (const note of extra ?? []) all.push({ side: note.side, lineNumber: note.line, metadata: { kind: "node", node: note.node } });
    if (draft) all.push({ side: draft.endSide ?? draft.side ?? "additions", lineNumber: draft.end, metadata: { kind: "box", range: draft } });
    return all;
  }, [sides, patch, comments, draft, extra]);
  if (file.binary) return muted(REVIEW_WORDS.binaryFile);
  if (contents && "error" in contents) {
    return (
      <ErrorLine
        size="sm"
        error={couldntReadDiff(contents.error)}
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
  if (!sides && !patch) {
    if (contents && "patch" in contents) return muted("Its diff is too large to show here");
    return (
      <p className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
        <Spinner className="size-icon-sm motion-safe:animate-spin" />
        {REVIEW_WORDS.loading}
      </p>
    );
  }
  if (sides && sides.before === sides.after) return muted(REVIEW_WORDS.noContentChanges);
  // A host's patch has no whole file to quote: its comments go with a review, not as chips [D262].
  const sideLines = (side: "additions" | "deletions") => (sides ? (side === "additions" ? sides.after : sides.before).split("\n") : []);
  const render = ({ metadata }: DiffNote<Note>) =>
    metadata.kind === "node" ? (
      <div className="p-2 font-sans">{metadata.node}</div>
    ) : metadata.kind === "comment" ? (
      <CommentNote comment={metadata.comment} onRemove={() => onRemoveComment(metadata.comment.id)} />
    ) : (
      <CommentBox
        start={Math.min(metadata.range.start, metadata.range.end)}
        end={Math.max(metadata.range.start, metadata.range.end)}
        initial={kept && kept.range.start === metadata.range.start && kept.range.end === metadata.range.end ? kept.text : ""}
        onText={(text) => onDraft?.({ range: metadata.range, text })}
        onCancel={() => setDraft(null)}
        onSubmit={(text) => {
          const side = metadata.range.side ?? "additions";
          const start = Math.min(metadata.range.start, metadata.range.end);
          const end = Math.max(metadata.range.start, metadata.range.end);
          const sent = onComment?.({ id: crypto.randomUUID(), path: file.path, side, start, end, excerpt: sideLines(side).slice(start - 1, end).join("\n"), text });
          if (sent) sent.then(() => setDraft(null), () => {});
          else setDraft(null);
        }}
      />
    );
  return (
    <DiffView<Note>
      source={sides ? { kind: "sides", path: file.path, before: sides.before, after: sides.after } : { kind: "patch", patch: patch ?? "", sides: whole }}
      look={look}
      annotations={notes}
      renderAnnotation={render}
      onGutterClick={onComment && pick}
      onSelect={onComment && pick}
      selected={draft}
    />
  );
}
