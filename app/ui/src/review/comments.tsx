import { type KeyboardEvent, useState } from "react";

import { Comment, Trash } from "../icons";
import { Button } from "../components/button";
import { Tile, TileRemove } from "../components/composer/attachments";
import { TooltipIconButton } from "../components/icon-button";
import { Kbd } from "../components/kbd";
import { keysOf, matches } from "../shortcuts";
import type { DiffComment } from "./types";

/**
 * Comments to the agent (D1040): select lines or press a line's +, write in the box under them, and the comment
 * becomes a chip above the composer with its excerpt. It stays marked on the diff until it's sent.
 */

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** "line 19", "lines 29–31". */
export const lineWords = (start: number, end: number) => (start === end ? `line ${start}` : `lines ${start}–${end}`);

/** The box under the picked lines: Comment (⌘⏎) makes it a chip, Cancel (Esc) drops it. */
export function CommentBox({
  start,
  end,
  initial = "",
  onText,
  onCancel,
  onSubmit,
}: {
  start: number;
  end: number;
  /** Its words as kept from before a restart (D1195). */
  initial?: string;
  onText?: (text: string) => void;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState(initial);
  const submit = () => text.trim() && onSubmit(text.trim());
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches(event.nativeEvent, "comment")) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") onCancel();
  };
  return (
    <div data-slot="comment-box" className="m-2 flex max-w-110 flex-col gap-2 rounded-overlay bg-popover p-2 font-sans shadow-overlay ring ring-border">
      <span className="px-1 text-xs text-muted-foreground">Comment on {lineWords(start, end)}</span>
      <textarea
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the box opens because the user asked to write in it
        autoFocus
        rows={2}
        value={text}
        aria-label={`Comment on ${lineWords(start, end)}`}
        onChange={(event) => {
          setText(event.target.value);
          onText?.(event.target.value);
        }}
        onKeyDown={onKeyDown}
        className="min-h-14 resize-none rounded-control bg-fill px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:focus-ring"
      />
      <div className="flex items-center justify-end gap-1">
        <Button variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" disabled={!text.trim()} onClick={submit}>
          Comment <Kbd variant="chip">{keysOf("comment")[0]}</Kbd>
        </Button>
      </div>
    </div>
  );
}

/** A comment waiting to be sent, marked under its lines; delete takes it and its chip away. */
export function CommentNote({ comment, onRemove }: { comment: DiffComment; onRemove: () => void }) {
  return (
    <div data-slot="comment-note" className="m-2 flex max-w-110 items-start gap-2 rounded-control bg-fill px-2.5 py-2 font-sans text-sm">
      <Comment className="mt-0.5 size-icon-sm shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-muted-foreground">You · {lineWords(comment.start, comment.end)}</span>
        <span className="text-foreground">{comment.text}</span>
      </span>
      <TooltipIconButton tooltip="Delete comment" size="icon-xs" onClick={onRemove}>
        <Trash />
      </TooltipIconButton>
    </div>
  );
}

/** A comment as a chip above the composer: the comment over its place and its first line's code (D1040). */
export function CommentChip({ comment, onRemove }: { comment: DiffComment; onRemove: () => void }) {
  const at = `${baseName(comment.path)}:${comment.start === comment.end ? comment.start : `${comment.start}–${comment.end}`}`;
  return (
    <Tile
      slot="composer-comment"
      hint={comment.text}
      icon={<Comment aria-hidden className="size-icon-md" />}
      title={comment.text}
      detail={
        <span className="flex min-w-0 gap-1.5">
          <span className="shrink-0">{at}</span>
          <span className="truncate font-mono">{comment.excerpt}</span>
        </span>
      }
      remove={<TileRemove label="Remove comment" onClick={onRemove} />}
    />
  );
}
