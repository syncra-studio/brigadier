import { Tabs } from "@base-ui/react/tabs";
import { type ReactNode, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { Branch, Check, CheckCircle, ChevronRight, Commit, Eye, Link, Publish, X } from "../icons";
import { Markdown } from "../thread/markdown";
import { PullRequestClosed, PullRequestDraft, PullRequestMerged, PullRequestOpen, XCircle } from "./icons";
import { type Sends, SendButton } from "./pr-parts";
import { ago } from "./pr-words";
import type { PrComment, PrItem, PrThread, PullRequest } from "./pull-requests";

// —— Conversation: the description, then what happened, oldest first, as GitHub's [D260].

function Avatar({ login }: { login: string }) {
  return <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground uppercase">{login[0]}</span>;
}

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
const WAS_WORDS = { approved: "previously approved these changes", changes: "previously requested changes" };

const REVIEW_ICONS = {
  approved: <CheckCircle className="text-success" />,
  changes: <XCircle className="text-destructive" />,
  commented: <Eye />,
  dismissed: <Eye />,
};

const MENTION_ICONS = { open: PullRequestOpen, draft: PullRequestDraft, merged: PullRequestMerged, closed: PullRequestClosed };

const ITEM_WORDS = {
  closed: ["closed this", <PullRequestClosed className="text-destructive" />],
  reopened: ["reopened this", <PullRequestOpen className="text-success" />],
  ready: ["marked this pull request as ready for review", <Eye />],
  draft: ["marked this pull request as draft", <PullRequestDraft />],
  force_pushed: ["force-pushed the branch", <Commit />],
} as const;

const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** One timeline entry, as GitHub draws it. */
function Item({ item, pr, comments, sends }: { item: PrItem; pr: PullRequest; comments: Map<string, PrComment>; sends: Sends }) {
  const at = item.atMs === null ? "" : ago(item.atMs, sends.now);
  const who = <Who login={item.actor} bot={item.bot} />;
  const sha = (oid: string | null) => oid && <span className="font-mono text-xs text-foreground">{oid.slice(0, 7)}</span>;
  switch (item.kind) {
    case "comment": {
      const comment = comments.get(item.id);
      if (!comment) return null;
      const box = <CommentBox comment={comment} at={at} author={pr.openedBy} sends={sends} />;
      return (
        <div className="flex gap-3">
          <Avatar login={comment.author} />
          {comment.minimized ? <Hidden reason={comment.minimized}>{box}</Hidden> : box}
        </div>
      );
    }
    case "commits": {
      const [one] = item.commits;
      if (item.commits.length === 1)
        return (
          <EventLine icon={<Commit />} at={at} end={sha(one.sha)}>
            {who} pushed <span className="text-foreground">{one.message}</span>
          </EventLine>
        );
      return (
        <div className="flex flex-col gap-1">
          <EventLine icon={<Commit />} at={at}>
            {who} added {item.commits.length} commits
          </EventLine>
          <ul className="flex flex-col gap-1 ps-9">
            {item.commits.map((commit) => (
              <li key={commit.sha} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate text-foreground">{commit.message}</span>
                {sha(commit.sha)}
              </li>
            ))}
          </ul>
        </div>
      );
    }
    case "review": {
      const body = item.said ? comments.get(item.id) : undefined;
      const changes = item.state === "changes";
      const review = (
        <div className="flex flex-col gap-2">
          <EventLine icon={REVIEW_ICONS[item.state]} at={at} end={changes && <SendButton send={{ kind: "event", id: item.id }} sends={sends} />}>
            {who} {item.state === "dismissed" && item.was ? WAS_WORDS[item.was] : REVIEW_WORDS[item.state]}
          </EventLine>
          {(body || item.threads.length > 0) && (
            <div className="flex flex-col gap-2 ps-9">
              {body && <CommentBox comment={body} did="left a comment" at="" author={pr.openedBy} sends={sends} />}
              {item.threads.map((thread) => (
                <Thread key={thread.id} thread={thread} comments={comments} author={pr.openedBy} sends={sends} />
              ))}
            </div>
          )}
        </div>
      );
      // A review GitHub hides shows as its hidden comment, the review under it.
      return item.minimized ? (
        <div className="flex gap-3">
          <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted svg:size-icon-sm">
            <Check />
          </span>
          <Hidden reason={item.minimized}>{review}</Hidden>
        </div>
      ) : (
        review
      );
    }
    case "requested": {
      const names = item.who.filter((name): name is string => name !== null);
      return (
        <EventLine icon={<Eye />} at={at}>
          {who} requested review from <span className="text-foreground">{list(names)}</span>
        </EventLine>
      );
    }
    case "dismissed":
      return (
        <EventLine icon={<X />} at={at}>
          {who} dismissed <span className="text-foreground">{item.who}</span>’s stale review{item.sha && <> via {sha(item.sha)}</>}
        </EventLine>
      );
    case "deployed": {
      const url = item.url;
      return (
        <EventLine
          icon={<Publish />}
          at={at}
          end={
            url && (
              <Button variant="soft" size="xs" onClick={() => sends.onOpen({ url })}>
                View deployment
              </Button>
            )
          }
        >
          {who} deployed to <span className="text-foreground">{item.env}</span>
        </EventLine>
      );
    }
    case "mentioned": {
      const Icon = MENTION_ICONS[item.state];
      const url = item.url;
      return (
        <div className="flex flex-col gap-1">
          <EventLine icon={<Link />} at={at}>
            {who} mentioned this pull request
          </EventLine>
          <button
            type="button"
            disabled={!url}
            onClick={() => url && sends.onOpen({ url })}
            className="ms-9 flex cursor-pointer items-center gap-2 rounded-control text-start text-sm text-foreground hover:underline focus-visible:focus-ring"
          >
            <Icon className={cx("size-icon-sm shrink-0", item.state === "merged" ? "text-pr-purple" : item.state === "closed" ? "text-destructive" : item.state === "open" ? "text-success" : "text-muted-foreground")} />
            <span className="min-w-0 truncate">
              {item.title} <span className="text-muted-foreground">#{item.number}</span>
            </span>
          </button>
        </div>
      );
    }
    case "merged":
      return (
        <EventLine icon={<PullRequestMerged className="text-pr-purple" />} at={at}>
          {who} merged commit {sha(item.sha)} into <span className="font-mono text-xs text-foreground">{item.base}</span>
        </EventLine>
      );
    case "deleted":
      return (
        <EventLine icon={<Branch />} at={at}>
          {who} deleted the <span className="font-mono text-xs text-foreground">{item.branch}</span> branch
        </EventLine>
      );
    default: {
      const [words, icon] = ITEM_WORDS[item.kind];
      return (
        <EventLine icon={icon} at={at}>
          {who} {words}
        </EventLine>
      );
    }
  }
}

/** A comment the user posted from the Add a comment box: on screen at once, until the read that has it [D260]. */
export type Posted = { key: string; body: string; id: string | null };

/**
 * The description as the first comment, then GitHub's timeline as Rust reads it, every bot's comment in its place
 * [D260], then the user's own comments still on their way.
 */
export function Conversation({ pr, posted, sends }: { pr: PullRequest; posted: readonly Posted[]; sends: Sends }) {
  const comments = new Map(pr.comments.map((comment) => [comment.id, comment]));
  const viewer = pr.viewer ?? "you";
  const description: PrComment = { id: "body", author: pr.openedBy, path: null, line: null, body: pr.body ?? "", atMs: pr.openedAtMs, url: pr.url };
  return (
    <div className="relative flex flex-col gap-4">
      {/* GitHub's line down the timeline, under its icons. */}
      <span aria-hidden className="absolute inset-y-0 start-3 w-px bg-border" />
      <div className="relative flex gap-3">
        <Avatar login={pr.openedBy} />
        <CommentBox comment={description} at={ago(pr.openedAtMs, sends.now)} author="" />
      </div>
      {(pr.timeline ?? []).map((item) => (
        <div key={`${item.kind}:${item.id}`} className="relative">
          <Item item={item} pr={pr} comments={comments} sends={sends} />
        </div>
      ))}
      {posted
        .filter((post) => post.id === null || !comments.has(post.id))
        .map((post) => (
          <div key={post.key} className="relative flex gap-3">
            <Avatar login={viewer} />
            <CommentBox comment={{ id: post.key, author: viewer, path: null, line: null, body: post.body, atMs: sends.now, url: null }} at={post.id ? "just now" : "· Posting…"} author={pr.openedBy} />
          </div>
        ))}
    </div>
  );
}

/** Where the PR stands at the timeline's end once it's done: merged, or closed unmerged, as GitHub's box. */
export function DoneBox({ pr }: { pr: PullRequest }) {
  const merged = pr.state === "merged";
  return (
    <div className="flex gap-3">
      <span className={cx("flex size-6 shrink-0 items-center justify-center rounded-full svg:size-icon-sm", merged ? "text-pr-purple" : "text-destructive")}>
        {merged ? <PullRequestMerged /> : <PullRequestClosed />}
      </span>
      <div className={cx("flex min-w-0 flex-1 flex-col rounded-surface border px-4 py-3", merged ? "border-pr-purple" : "border-border")}>
        <span className="text-sm font-medium text-foreground">{merged ? "Pull request successfully merged and closed" : "Closed with unmerged commits"}</span>
        <span className="text-xs text-muted-foreground">{merged ? "You’re all set — the branch has been merged." : "This pull request is closed."}</span>
      </div>
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
      <Avatar login={viewer ?? "?"} />
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
