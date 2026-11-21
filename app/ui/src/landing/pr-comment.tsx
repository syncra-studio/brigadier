import { type ReactNode, useEffect, useRef, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { ConfirmDialog } from "../components/confirm-dialog";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/menu";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { Textarea } from "../components/textarea";
import { showToast } from "../components/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { ask } from "../daemon";
import { ArrowUpRight, ChevronRight, DotsHorizontal, Pencil } from "../icons";
import { SimpleSmile } from "../icons/note";
import { ArrowCurvedLeft, Chat, Trash } from "../icons/thread";
import { Markdown } from "../thread/markdown";
import { prAct, said } from "./pr-act";
import { Avatar, type Sends } from "./pr-parts";
import { ago } from "./pr-words";
import type { PrComment, PrReaction, PullRequest } from "./pull-requests";

/** A body's HTML as GitHub shows it, for our Markdown: an `<a>` its link, a line break its own, other tags gone, their
 * text kept. */
// shortcut: tags are dropped, not drawn (an <img> or <sup> badge goes), and HTML inside code is treated the same,
// until a body needs more of GitHub's HTML.
const untagged = (html: string) =>
  html
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[a-z][^>]*>/gi, "");

/**
 * A comment's words as GitHub shows them [D260]: its HTML comments hidden (bots' markers), each `<details>` a fold
 * opened by its `<summary>`, closed unless it says `open`, and the rest drawn by our Markdown.
 */
export function Body({ text, keep }: { text: string; keep: string }) {
  const parts: ReactNode[] = [];
  let rest = text.replace(/<!--[\s\S]*?-->/g, "");
  for (let n = 0; ; n++) {
    const start = rest.search(/<details[\s>]/i);
    if (start < 0) break;
    // Its own </details>, past any folds inside it.
    const tags = /<(\/?)details[\s>]/gi;
    tags.lastIndex = start + 1;
    let depth = 1;
    let end = rest.length;
    for (let tag; depth > 0 && (tag = tags.exec(rest)); ) {
      depth += tag[1] ? -1 : 1;
      if (depth === 0) end = tag.index;
    }
    const inner = rest.slice(start, end).replace(/^<details[^>]*>/i, "");
    const summary = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(inner);
    const before = untagged(rest.slice(0, start)).trim();
    if (before) parts.push(<Markdown key={`m${n}`} text={before} keep={`${keep}:${n}`} />);
    parts.push(
      <Collapsible key={`d${n}`} defaultOpen={/^<details[^>]*\bopen\b/i.test(rest.slice(start))} className="my-1">
        <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 rounded-control text-start font-medium hover:text-foreground focus-visible:focus-ring">
          <ChevronRight className="size-icon-xs shrink-0 transition-transform group-data-panel-open:rotate-90" />
          {untagged(summary?.[1] ?? "Details").trim()}
        </CollapsibleTrigger>
        <CollapsibleContent className="ps-4">
          <Body text={summary ? inner.slice(summary.index + summary[0].length) : inner} keep={`${keep}:${n}d`} />
        </CollapsibleContent>
      </Collapsible>,
    );
    rest = rest.slice(end).replace(/^<\/details>/i, "");
  }
  const after = untagged(rest).trim();
  if (after) parts.push(<Markdown key="end" text={after} keep={`${keep}:end`} />);
  return parts;
}

/** GitHub's eight reactions, in its order. */
const EMOJI: Record<string, string> = { THUMBS_UP: "👍", THUMBS_DOWN: "👎", LAUGH: "😄", HOORAY: "🎉", CONFUSED: "😕", HEART: "❤️", ROCKET: "🚀", EYES: "👀" };

/**
 * A comment's or the PR's reactions: each a pill of its emoji and count, the viewer's own tinted, a press
 * adding or taking back theirs; then Add reaction. Shown at once, put right when GitHub refuses [D166].
 */
export function Reactions({ pr, subject, reactions = [], onChanged }: { pr: PullRequest; subject: string; reactions?: PrReaction[]; onChanged: () => void }) {
  const [shown, setShown] = useState<PrReaction[] | null>(null);
  const now = shown ?? reactions;
  const [picking, setPicking] = useState(false);
  const toggle = (content: string) => {
    setPicking(false);
    const had = now.find((each) => each.content === content);
    const mine = Boolean(had?.mine);
    const next = had
      ? now.map((each) => (each.content === content ? { ...each, mine: !mine, count: each.count + (mine ? -1 : 1) } : each)).filter((each) => each.count > 0)
      : [...now, { content, count: 1, mine: true }];
    setShown(next);
    prAct("react", pr.ref!, subject, content, mine ? "off" : "on")
      .catch((cause: Error) => (setShown(null), showToast(cause.message, { tone: "error" })))
      .finally(onChanged);
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      {now.map((each) => (
        <button
          key={each.content}
          type="button"
          aria-pressed={each.mine}
          aria-label={`${EMOJI[each.content] ?? each.content}, ${each.count} reaction${each.count === 1 ? "" : "s"}`}
          onClick={() => toggle(each.content)}
          className="flex h-6 cursor-pointer items-center gap-1 rounded-capsule border border-border px-2 text-xs tabular-nums hover:bg-fill aria-pressed:border-link aria-pressed:bg-fill focus-visible:focus-ring"
        >
          {EMOJI[each.content]}
          <span>{each.count}</span>
        </button>
      ))}
      <Popover open={picking} onOpenChange={setPicking}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                aria-label="Add reaction"
                className="flex size-6 cursor-pointer items-center justify-center rounded-capsule text-muted-foreground hover:bg-fill hover:text-foreground focus-visible:focus-ring svg:size-icon-sm"
              />
            }
          >
            <SimpleSmile />
          </TooltipTrigger>
          <TooltipContent>Add reaction</TooltipContent>
        </Tooltip>
        <PopoverContent className="flex gap-0.5 p-1">
          {Object.entries(EMOJI).map(([content, emoji]) => (
            <button key={content} type="button" aria-label={content.toLowerCase().replace("_", " ")} onClick={() => toggle(content)} className="flex size-8 cursor-pointer items-center justify-center rounded-control text-base hover:bg-fill focus-visible:focus-ring">
              {emoji}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Words written for GitHub: a box, then Cancel and the verb; the words kept when GitHub refuses, with why [D165]. */
export function Writer({
  initial = "",
  placeholder,
  verb,
  label,
  onSend,
  onCancel,
  rows = 4,
  quote,
  mentions,
}: {
  initial?: string;
  placeholder?: string;
  verb: string;
  label: string;
  onSend: (text: string) => Promise<void>;
  onCancel?: () => void;
  rows?: number;
  /** A quote asked for: added to the words, once per ask. */
  quote?: { text: string; n: number };
  /** The PR whose people an `@` suggests [D165]. */
  mentions?: string;
}) {
  const [text, setText] = useState(initial);
  const box = useRef<HTMLTextAreaElement>(null);
  // The `@name` being typed at the caret, and who GitHub suggests for it.
  const [at, setAt] = useState<{ word: string; end: number } | null>(null);
  const [people, setPeople] = useState<{ login: string; name: string | null }[]>([]);
  useEffect(() => {
    if (!mentions || !at) return setPeople([]);
    const timer = setTimeout(() => ask({ op: "run", args: ["host", "@", "users", mentions, at.word] }, (reply) => setPeople(reply.ok ? (reply.users as typeof people).slice(0, 6) : [])), 250);
    return () => clearTimeout(timer);
  }, [mentions, at?.word]);
  const typed = (value: string, caret: number) => {
    setText(value);
    const word = /(?:^|\s)@([\w-]*)$/.exec(value.slice(0, caret));
    setAt(word ? { word: word[1]!, end: caret } : null);
  };
  const mention = (login: string) => {
    if (!at) return;
    const start = at.end - at.word.length;
    setText(`${text.slice(0, start)}${login} ${text.slice(at.end)}`);
    setAt(null);
    box.current?.focus();
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quoted, setQuoted] = useState(0);
  if (quote && quote.n !== quoted) {
    setQuoted(quote.n);
    setText((now) => `${now ? `${now}\n\n` : ""}${quote.text}\n\n`);
  }
  const send = () => {
    setBusy(true);
    setError(null);
    onSend(text.trim()).then(
      () => (setBusy(false), setText("")),
      (cause: Error) => (setBusy(false), setError(cause.message)),
    );
  };
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label={label}
        rows={rows}
        ref={box}
        value={text}
        disabled={busy}
        placeholder={placeholder}
        onChange={(event) => typed(event.target.value, event.target.selectionStart)}
        onKeyDown={(event) => event.key === "Enter" && (event.metaKey || event.ctrlKey) && text.trim() && send()}
      />
      {at && people.length > 0 && (
        <ul aria-label="People" className="flex flex-col rounded-control border border-border p-1">
          {people.map((person) => (
            <li key={person.login}>
              <button type="button" onClick={() => mention(person.login)} className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-control px-2 text-start text-sm hover:bg-fill focus-visible:focus-ring">
                <Avatar login={person.login} size="size-4" />
                <span className="text-foreground">{person.login}</span>
                {person.name && <span className="truncate text-muted-foreground">{person.name}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorLine error={error} />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button size="sm" disabled={busy || !text.trim()} onClick={send}>
          {verb}
        </Button>
      </div>
    </div>
  );
}

/** A line quoted for a reply, as GitHub quotes: each line after `> `. */
export const quoted = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

/**
 * A comment [D165 D166]: its author's picture, name, what they did and when, Pending (only they see it
 * until the review goes) and its … menu: Quote reply, Add to chat, Edit, Delete (asked first), Open comment. Then its
 * words, or the box editing them, and its reactions.
 */
export function CommentCard({
  pr,
  comment,
  did = "commented",
  sends,
  onQuote,
  onAddToChat,
}: {
  pr: PullRequest;
  comment: PrComment;
  did?: string;
  sends: Sends;
  onQuote?: (text: string) => void;
  onAddToChat?: (comment: PrComment) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const node = comment.node;
  const remove = () => {
    setBusy(true);
    prAct("comment-delete", pr.ref!, node!)
      .then(
        () => showToast("Comment deleted"),
        (cause: Error) => showToast(cause.message || "GitHub could not delete this comment", { tone: "error" }),
      )
      .finally(() => (setBusy(false), setDeleting(false), sends.onChanged()));
  };
  return (
    <div className="group/comment flex min-w-0 gap-3">
      <Avatar login={comment.author} at={pr.checkedAtMs} size="size-6" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-h-6 items-center gap-1.5 text-sm text-muted-foreground">
          <span className="truncate font-medium text-foreground">{comment.author || "ghost"}</span>
          {comment.bot && <Badge variant="outline">Bot</Badge>}
          <span className="shrink-0">
            {did} {ago(comment.atMs, sends.now)}
          </span>
          {comment.pending && (
            <Tooltip>
              <TooltipTrigger render={<span />}>
                <Badge variant="outline">Pending</Badge>
              </TooltipTrigger>
              <TooltipContent>Only visible to you until review is submitted</TooltipContent>
            </Tooltip>
          )}
          <span className="flex-1" />
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger
              aria-label="Comment actions"
              className="flex size-6 cursor-pointer items-center justify-center rounded-control opacity-0 group-hover/comment:opacity-100 hover:bg-fill focus-visible:opacity-100 focus-visible:focus-ring aria-expanded:opacity-100 svg:size-icon-sm"
            >
              <DotsHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onQuote && (
                <DropdownMenuItem onClick={() => onQuote(quoted(comment.body))}>
                  <ArrowCurvedLeft />
                  Quote reply
                </DropdownMenuItem>
              )}
              {onAddToChat && (
                <DropdownMenuItem onClick={() => onAddToChat(comment)}>
                  <Chat />
                  Add to chat
                </DropdownMenuItem>
              )}
              {node && comment.canEdit && (
                <DropdownMenuItem onClick={() => setEditing(true)}>
                  <Pencil />
                  Edit
                </DropdownMenuItem>
              )}
              {comment.url && (
                <DropdownMenuItem onClick={() => sends.onOpen({ url: comment.url! })}>
                  <ArrowUpRight />
                  Open comment
                </DropdownMenuItem>
              )}
              {node && comment.canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                    <Trash />
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {editing ? (
          <Writer
            label="Edit comment"
            initial={comment.body}
            verb="Save"
            onCancel={() => setEditing(false)}
            onSend={(text) => prAct("comment-edit", pr.ref!, node!, ...said(text)).then(() => (setEditing(false), sends.onChanged()))}
          />
        ) : (
          <div className={cx("min-w-0 text-sm", busy && "opacity-disabled")}>
            <Body text={comment.body.trim() || "_No description provided._"} keep={`pr-${comment.id}`} />
          </div>
        )}
        {node && !comment.pending && <Reactions pr={pr} subject={node} reactions={comment.reactions} onChanged={sends.onChanged} />}
      </div>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete comment"
        description="This comment will be permanently deleted from GitHub"
        cancel="Cancel"
        confirm={busy ? "Deleting..." : "Delete comment"}
        destructive
        busy={busy}
        onConfirm={remove}
      />
    </div>
  );
}
