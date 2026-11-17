import { Tabs } from "@base-ui/react/tabs";
import { type ReactNode, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { CheckCircle, ChevronRight, Minus } from "../icons";
import { Markdown } from "../thread/markdown";
import { Clock, XCircle } from "./icons";
import { Avatar, type Sends, SendButton } from "./pr-parts";
import { ago } from "./pr-words";
import type { PrCheck, PrComment, PrThread, PullRequest } from "./pull-requests";

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
function Body({ text, keep }: { text: string; keep: string }) {
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

const Who = ({ login, bot }: { login: string | null; bot?: boolean }) => (
  <>
    <span className="font-medium text-foreground">{login ?? "ghost"}</span>
    {bot && (
      <Badge variant="outline" className="ms-1 align-middle">
        Bot
      </Badge>
    )}
  </>
);

/** A comment's box: who, what they did and when, Author or Bot, the words, and Send to agent. */
function CommentBox({ comment, did = "commented", at, author, sends }: { comment: PrComment; did?: string; at: string; author: string; sends?: Sends }) {
  const where = comment.path && (comment.line === null ? comment.path : `${comment.path}:${comment.line}`);
  return (
    <div className="min-w-0 flex-1 overflow-clip rounded-surface border border-border">
      <div className="flex min-h-control-md items-center gap-2 border-b border-border bg-fill-subtle px-3 py-1 text-xs text-muted-foreground">
        <span className="shrink-0">
          <Who login={comment.author} bot={comment.bot} />
        </span>
        <span className="shrink-0">
          {did} {at}
        </span>
        {where && <span className="min-w-0 truncate font-mono">{where}</span>}
        <span className="flex-1" />
        {comment.author === author && <Badge variant="outline">Author</Badge>}
        {sends && <SendButton send={{ kind: "comment", id: comment.id }} sends={sends} />}
      </div>
      <div className="px-3 py-2 text-sm">
        <Body text={comment.body.trim() || "_No description provided._"} keep={`pr-${comment.id}`} />
      </div>
    </div>
  );
}

/** A row on the timeline's line: its icon, what happened and when, and an action at its end. */
function EventLine({ icon, at, children, end }: { icon: ReactNode; at: string; children: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex min-h-control-sm items-center gap-3 text-sm text-muted-foreground">
      <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted svg:size-icon-sm">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        {children} <span className="text-xs whitespace-nowrap">{at}</span>
      </span>
      {end}
    </div>
  );
}

/** A comment GitHub hides ("marked as outdated"), opened on a click. */
function Hidden({ reason, children }: { reason: string; children: ReactNode }) {
  return (
    <Collapsible className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex min-h-control-md items-center gap-2 rounded-surface border border-border px-3 text-sm text-muted-foreground italic">
        <span className="flex-1">This comment was marked as {reason}.</span>
        <CollapsibleTrigger className="group cursor-pointer rounded-control px-1.5 py-0.5 text-xs not-italic hover:text-foreground focus-visible:focus-ring">
          <span className="group-data-panel-open:hidden">Show comment</span>
          <span className="hidden group-data-panel-open:inline">Hide comment</span>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** A review's line thread, folded when resolved or outdated, as GitHub's. */
function Thread({ thread, comments, author, sends }: { thread: PrThread; comments: Map<string, PrComment>; author: string; sends: Sends }) {
  const said = thread.comments.flatMap((id) => comments.get(id) ?? []);
  const folded = thread.resolved || thread.outdated;
  return (
    <Collapsible defaultOpen={!folded} className="overflow-clip rounded-surface border border-border">
      <CollapsibleTrigger className="group flex min-h-control-md w-full cursor-pointer items-center gap-2 px-3 text-start text-xs hover:bg-fill-subtle focus-visible:focus-ring">
        <ChevronRight className="size-icon-xs shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
        <span className="min-w-0 truncate font-mono text-foreground">{thread.path}</span>
        {thread.outdated && <Badge variant="outline">Outdated</Badge>}
        {thread.resolved && <Badge variant="outline">Resolved</Badge>}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 border-t border-border p-3">
        {said.map((comment) => (
          <CommentBox key={comment.id} comment={{ ...comment, path: null }} at={ago(comment.atMs, sends.now)} author={author} sends={sends} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

const REVIEW_WORDS = {
  approved: "approved these changes",
  changes: "requested changes",
  commented: "reviewed",
  dismissed: "reviewed",
};

/** A comment the user posted from the Add a comment box: on screen at once, until the read that has it [D260]. */
export type Posted = { key: string; body: string; id: string | null };

const SECTION = "flex flex-col gap-2 border-b border-divider pb-4";
const H3 = "text-sm font-medium text-foreground";
const QUIET = "text-xs text-muted-foreground";

const VERDICT = {
  approved: { words: "Approved", tint: "text-success" },
  changes: { words: "Changes requested", tint: "text-destructive" },
  commented: { words: "Commented", tint: "text-muted-foreground" },
  requested: { words: "Review requested", tint: "text-muted-foreground" },
};

const GROUPS: { state: PrCheck["state"]; words: string; icon: ReactNode }[] = [
  { state: "running", words: "Pending", icon: <Clock className="text-pr-yellow" /> },
  { state: "failed", words: "Failed or cancelled", icon: <XCircle className="text-destructive" /> },
  { state: "passed", words: "Passed", icon: <CheckCircle className="text-success" /> },
  { state: "skipped", words: "Skipped or neutral", icon: <Minus className="text-muted-foreground" /> },
];

const FOLD = "group flex h-control-md w-full cursor-pointer items-center gap-2 rounded-control px-2 text-start text-sm hover:bg-fill-subtle focus-visible:focus-ring svg:size-icon-sm";

/**
 * The checks [D609]: one folded line of counts by group; opened, each group folds with its checks, each opening its
 * run on the host; a failed one keeps Send log to agent [D1019].
 */
function Checks({ pr, sends }: { pr: PullRequest; sends: Sends }) {
  const groups = GROUPS.map((g) => ({ ...g, checks: pr.checks.filter((c) => c.state === g.state) })).filter((g) => g.checks.length);
  if (!groups.length) return <p className="px-2 text-sm text-muted-foreground">No checks reported</p>;
  return (
    <Collapsible>
      <CollapsibleTrigger className={FOLD}>
        <span className="flex">{groups[0].icon}</span>
        <span className="flex min-w-0 flex-1 flex-wrap gap-x-2 text-muted-foreground">
          {groups.map((g) => (
            <span key={g.state}>
              {g.checks.length} {g.words}
            </span>
          ))}
        </span>
        <ChevronRight className="text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-1 pt-1">
        {groups.map((g) => (
          <Collapsible key={g.state} defaultOpen>
            <CollapsibleTrigger className={FOLD}>
              <span className="flex">{g.icon}</span>
              <span className="flex-1 text-foreground">{g.words}</span>
              <span className="text-muted-foreground tabular-nums">{g.checks.length}</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="ms-6 flex flex-col">
                {g.checks.map((check) => (
                  <li key={check.id} className="flex min-h-8 items-center gap-2">
                    <button type="button" onClick={() => sends.onOpen({ check: check.id })} className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-control px-2 text-start text-sm hover:bg-fill-subtle focus-visible:focus-ring svg:size-icon-sm">
                      <span className="flex">{g.icon}</span>
                      <span className="min-w-0 flex-1">{check.name}</span>
                    </button>
                    {check.state === "failed" && <SendButton send={{ kind: "check", id: check.id }} label="Send log to agent" sends={sends} />}
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A pull request's Summary [D609, D613, D614]: its labels, reviewers and checks, the description, the
 * review comments by line; then its other comments, just as compact, with the user's own still on their way,
 * and Add a comment [D260, D1017].
 */
export function Summary({ pr, posted, sends, onComment }: { pr: PullRequest; posted: readonly Posted[]; sends: Sends; onComment: (body: string) => Promise<string | null> }) {
  const comments = new Map(pr.comments.map((comment) => [comment.id, comment]));
  const viewer = pr.viewer ?? "you";
  const timeline = pr.timeline ?? [];
  const reviews = timeline.filter((item) => item.kind === "review").filter((item) => item.said || item.threads.length);
  const talk = timeline.flatMap((item) => (item.kind === "comment" ? (comments.get(item.id) ?? []) : []));
  const waiting = posted.filter((post) => post.id === null || !comments.has(post.id));
  const said = (comment: PrComment, box: ReactNode) => (
    <div key={comment.id} className="flex gap-3">
      <Avatar login={comment.author} size="size-6" />
      {comment.minimized ? <Hidden reason={comment.minimized}>{box}</Hidden> : box}
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      {!!pr.labels?.length && (
        <ul aria-label="Labels" className="flex flex-wrap gap-1.5">
          {pr.labels.map((label) => (
            <li key={label} className="rounded-control bg-muted px-2 py-1 text-xs text-foreground">
              {label}
            </li>
          ))}
        </ul>
      )}
      <section className={SECTION}>
        <h3 className={H3}>Reviewers</h3>
        {pr.reviewers.length ? (
          pr.reviewers.map((r) => (
            <div key={r.login} className="flex items-center gap-2 text-xs">
              <Avatar login={r.login} />
              <span className="min-w-0 flex-1 truncate text-foreground">{r.login}</span>
              <span className={VERDICT[r.state].tint}>{VERDICT[r.state].words}</span>
            </div>
          ))
        ) : (
          <p className={QUIET}>No reviews yet</p>
        )}
      </section>
      <section className={SECTION}>
        <div className="-mx-2">
          <Checks pr={pr} sends={sends} />
        </div>
      </section>
      <section className="text-sm">{pr.body?.trim() ? <Body text={pr.body} keep={`pr-${pr.id}-body`} /> : <p className="text-muted-foreground">No description provided.</p>}</section>
      <section className="flex flex-col gap-3">
        <h3 className={H3}>Review comments</h3>
        {reviews.length ? (
          reviews.map((review) => {
            const body = review.said ? comments.get(review.id) : undefined;
            return (
              <div key={review.id} className="flex flex-col gap-2">
                {body && said(body, <CommentBox comment={body} did={REVIEW_WORDS[review.state]} at={ago(body.atMs, sends.now)} author={pr.openedBy} sends={sends} />)}
                <div className="ms-9 flex flex-col gap-2">
                  {review.threads.map((thread) => (
                    <Thread key={thread.id} thread={thread} comments={comments} author={pr.openedBy} sends={sends} />
                  ))}
                </div>
              </div>
            );
          })
        ) : (
          <p className={QUIET}>No inline review comments.</p>
        )}
      </section>
      <section className="flex flex-col gap-3">
        <h3 className={H3}>Comments</h3>
        {talk.map((comment) => said(comment, <CommentBox comment={comment} at={ago(comment.atMs, sends.now)} author={pr.openedBy} sends={sends} />))}
        {waiting.map((post) => {
          const mine: PrComment = { id: post.key, author: viewer, path: null, line: null, body: post.body, atMs: sends.now, url: null };
          return said(mine, <CommentBox comment={mine} at={post.id ? "just now" : "· Posting…"} author={pr.openedBy} />);
        })}
        {!talk.length && !waiting.length && <p className={QUIET}>No comments yet.</p>}
        <AddComment viewer={pr.viewer} offline={sends.offline} onPost={onComment} />
      </section>
    </div>
  );
}

const WRITE_TAB = cx("cursor-pointer rounded-control px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:focus-ring data-active:bg-fill-subtle data-active:text-foreground");

/**
 * GitHub's Add a comment: Write or Preview, then Comment (⌘⏎), posted through the user's gh as a comment on the PR
 * [D260]. The box empties at once, the comment showing in the timeline; if the host refuses it, the words come back
 * with why.
 */
export function AddComment({ viewer, offline, onPost }: { viewer: string | null | undefined; offline: boolean; onPost: (body: string) => Promise<string | null> }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const post = async () => {
    const body = text.trim();
    if (!body || offline) return;
    setText("");
    setError(null);
    const why = await onPost(body);
    if (why) {
      setText((now) => now || body);
      setError(why);
    }
  };
  return (
    <div className="flex gap-3">
      <Avatar login={viewer ?? "?"} size="size-6" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="text-sm font-medium text-foreground">Add a comment</span>
        <Tabs.Root defaultValue="write" className="flex flex-col overflow-clip rounded-surface border border-border">
          <Tabs.List className="flex gap-1 border-b border-border bg-fill-subtle px-2 py-1.5">
            <Tabs.Tab value="write" className={WRITE_TAB}>
              Write
            </Tabs.Tab>
            <Tabs.Tab value="preview" className={WRITE_TAB}>
              Preview
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="write" className="p-2">
            <textarea
              value={text}
              aria-label="Add a comment"
              placeholder="Add your comment here..."
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void post();
                }
              }}
              className="block min-h-24 w-full resize-y rounded-control bg-fill px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:focus-ring"
            />
          </Tabs.Panel>
          <Tabs.Panel value="preview" className="min-h-24 px-3 py-2 text-sm">
            {text.trim() ? <Markdown text={text} keep="pr-preview" /> : <span className="text-muted-foreground">Nothing to preview</span>}
          </Tabs.Panel>
          <div className="flex items-center gap-3 border-t border-border px-3 py-2">
            <span className="flex-1 text-xs text-muted-foreground">Markdown is supported</span>
            <Button size="sm" disabled={!text.trim() || offline} onClick={() => void post()}>
              Comment
            </Button>
          </div>
        </Tabs.Root>
        <ErrorLine error={error} />
      </div>
    </div>
  );
}
