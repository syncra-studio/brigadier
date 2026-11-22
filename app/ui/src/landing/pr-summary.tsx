import { type ReactNode, useState } from "react";

import { Button } from "../components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { copyWithToast } from "../components/copy-button";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "../components/menu";
import { Segmented } from "../components/segmented";
import { Textarea } from "../components/textarea";
import { showToast } from "../components/toast";
import { ArrowRight, Branch, Check, ChevronDown, ChevronRight, Filter, Pencil, Spinner } from "../icons";
import { Eye } from "../icons/settings";
import { Commit } from "../icons/thread";
import { prAct, said } from "./pr-act";
import { PrAside } from "./pr-aside";
import { Body, CommentCard, Reactions, Writer } from "./pr-comment";
import { Avatar, type Sends, StateIcon } from "./pr-parts";
import { ThreadCard } from "./pr-thread";
import { ago, STATE_WORDS } from "./pr-words";
import type { PrComment, PrItem, PullRequest } from "./pull-requests";

const PILL = {
  open: "text-success",
  draft: "text-muted-foreground",
  merged: "text-pr-purple",
  closed: "text-destructive",
};
const PILL_LOOK = "inline-flex h-6.5 items-center gap-1 state-pill rounded-capsule px-2.5 text-sm leading-5 font-medium whitespace-nowrap svg:size-icon-xs";

/** A header value that copies itself on a press: plain text, "Copy …" its tooltip, Copied its toast. */
function Copy({ value, label, className, children }: { value: string; label: string; className?: string; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={`Copy ${value}`} onClick={() => copyWithToast(value, "Copied")} className={cx("min-w-0 max-w-full cursor-pointer underline-offset-2 hover:text-foreground focus-visible:underline focus-visible:outline-none", className)}>
      {children}
    </button>
  );
}

/** A branch cut in its middle, its last 6 letters always shown. */
const BranchName = ({ name }: { name: string }) => (
  <span className="flex max-w-50 min-w-0 text-base">
    <span className="truncate">{name.slice(0, -6)}</span>
    <span className="shrink-0">{name.slice(-6)}</span>
  </span>
);

const MOVES = [
  { to: "draft", label: "Draft" },
  { to: "open", label: "Open" },
  { to: "closed", label: "Closed" },
] as const;

/** The state's pill; for who may change it, a menu of Draft / Open / Closed, the current one checked [D238]. */
function StatePill({ pr, sends }: { pr: PullRequest; sends: Sends }) {
  const [busy, setBusy] = useState(false);
  const icon = <StateIcon state={pr.state} className="svg:size-icon-xs" />;
  if (!pr.canEdit || !pr.ref || pr.state === "merged") {
    return (
      <span className={cx(PILL_LOOK, PILL[pr.state])}>
        {icon}
        {STATE_WORDS[pr.state]}
      </span>
    );
  }
  const move = (to: (typeof MOVES)[number]["to"]) => {
    const verb = to === "draft" ? "draft" : to === "closed" ? "close" : pr.state === "draft" ? "ready" : "reopen";
    setBusy(true);
    prAct(verb, pr.ref!)
      .catch((cause: Error) => showToast(cause.message || "GitHub could not update this pull request", { tone: "error" }))
      .finally(() => (setBusy(false), sends.onChanged()));
  };
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger aria-busy={busy || undefined} disabled={busy} className={cx(PILL_LOOK, PILL[pr.state], "cursor-pointer focus-visible:focus-ring")}>
        {icon}
        {STATE_WORDS[pr.state]}
        {busy ? <Spinner className="motion-safe:animate-spin" /> : <ChevronDown />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {MOVES.map(({ to, label }) => (
          <DropdownMenuItem key={to} disabled={pr.state === to || (pr.state === "closed" && to === "draft")} onClick={() => move(to)}>
            <span className="flex-1">{label}</span>
            {pr.state === to && <Check />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The title: its pencil always after it for who may edit, opening it in place; Save sends it to GitHub [D165 D238]. */
function Title({ pr, sends }: { pr: PullRequest; sends: Sends }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    if (!editing?.trim() || editing.trim() === pr.title) return setEditing(null);
    setBusy(true);
    setError(null);
    prAct("edit", pr.ref!, "--title", editing.trim())
      .then(() => setEditing(null), (cause: Error) => setError(cause.message))
      .finally(() => (setBusy(false), sends.onChanged()));
  };
  if (editing !== null) {
    return (
      <form
        className="flex flex-col gap-3"
        aria-busy={busy}
        onSubmit={(event) => (event.preventDefault(), save())}
        onKeyDown={(event) => event.key === "Escape" && !busy && (event.preventDefault(), setEditing(null))}
      >
        <span className="-mx-2 -my-1 block rounded-xl border border-border bg-fill-subtle px-2 py-1 focus-within:border-ring">
          <textarea
            aria-label="Pull request title"
            autoFocus
            rows={1}
            value={editing}
            disabled={busy}
            onChange={(event) => setEditing(event.target.value.replace(/[\r\n]+/g, " "))}
            onKeyDown={(event) => event.key === "Enter" && (event.preventDefault(), save())}
            className="field-sizing-content block max-h-24 w-full resize-none bg-transparent font-display text-2xl leading-tight font-medium tracking-tight outline-none focus-visible:outline-none"
          />
        </span>
        <ErrorLine error={error} />
        <div className="flex gap-1.5">
          <Button size="sm" type="submit" disabled={busy || !editing.trim()}>
            {busy ? <Spinner className="motion-safe:animate-spin" /> : <Check />}
            Save
          </Button>
          {!busy && (
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    );
  }
  return (
    <header className="font-display text-2xl leading-tight font-medium tracking-tight text-pretty">
      <h1 className="inline break-words">{pr.title}</h1>
      {pr.canEdit && pr.ref && (
        <span className="ms-1 inline-flex align-middle">
          <button type="button" aria-label="Edit title" title="Edit title" onClick={() => setEditing(pr.title)} className="inline-flex size-6 cursor-pointer items-center justify-center rounded-control text-muted-foreground hover:bg-fill hover:text-foreground focus-visible:focus-ring svg:size-icon-sm">
            <Pencil />
          </button>
        </span>
      )}
    </header>
  );
}

/** The heading [D238]: the state pill, repo and #n; the title; who opened it, when, and head → base. */
function Heading({ pr, sends }: { pr: PullRequest; sends: Sends }) {
  const repo = pr.repo ?? pr.url.split("/").slice(-4, -2).join("/");
  return (
    <section aria-label="Pull request summary" className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-baseline gap-2 text-sm select-none">
        <span className="flex shrink-0">
          <StatePill pr={pr} sends={sends} />
        </span>
        <span className="flex min-w-0 items-baseline gap-1 text-muted-foreground">
          <Copy value={repo} label={`Copy repository name ${repo}`} className="truncate">
            {repo.split("/").pop()}
          </Copy>
          <Copy value={String(pr.number)} label={`Copy pull request number #${pr.number}`} className="shrink-0">
            #{pr.number}
          </Copy>
        </span>
      </div>
      <Title pr={pr} sends={sends} />
      <div className="flex min-w-0 items-center gap-x-2 overflow-x-clip text-base text-faint-foreground">
        <span className="inline-flex min-w-0 shrink-0 items-center gap-2 whitespace-nowrap">
          <span className="inline-flex min-w-0 items-center gap-2.5">
            <Avatar login={pr.openedBy} at={pr.checkedAtMs} size="size-5" />
            <span className="min-w-0 truncate text-foreground">{pr.openedBy}</span>
          </span>
          <time title={new Date(pr.openedAtMs).toLocaleString()}>{ago(pr.openedAtMs, sends.now)}</time> ·
        </span>
        <span className="flex min-w-0 items-center gap-2 text-muted-foreground svg:size-icon-sm">
          <Copy value={pr.branch} label={`Copy source branch ${pr.branch}`}>
            <BranchName name={pr.branch} />
          </Copy>
          <ArrowRight className="shrink-0 text-faint-foreground" />
          <Copy value={pr.base} label={`Copy target branch ${pr.base}`}>
            <BranchName name={pr.base} />
          </Copy>
        </span>
      </div>
    </section>
  );
}

/** The description: drawn as GitHub has it; Edit opens Write | Preview, Save sends it [D165]. */
function Description({ pr, sends }: { pr: PullRequest; sends: Sends }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    setBusy(true);
    setError(null);
    prAct("edit", pr.ref!, "--body", ...said(editing ?? ""))
      .then(() => setEditing(null), (cause: Error) => setError(cause.message))
      .finally(() => (setBusy(false), sends.onChanged()));
  };
  if (editing !== null) {
    return (
      <section className="flex flex-col gap-2">
        <Segmented label="Description editor mode" value={mode} options={[{ value: "write", label: "Write" }, { value: "preview", label: "Preview" }]} onChange={setMode} className="self-start" />
        {mode === "write" ? (
          <Textarea aria-label="Pull request description" rows={10} autoFocus value={editing} disabled={busy} onChange={(event) => setEditing(event.target.value)} />
        ) : (
          <div className="min-h-40 rounded-control border border-border px-3 py-2 text-sm">{editing.trim() ? <Body text={editing} keep={`pr-${pr.id}-preview`} /> : <p className="text-muted-foreground">Nothing to preview</p>}</div>
        )}
        <ErrorLine error={error} />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(null)}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy} onClick={save}>
            Save
          </Button>
        </div>
      </section>
    );
  }
  return (
    <section className="group/description relative flex flex-col gap-3 text-sm">
      {pr.canEdit && (
        <Button size="xs" variant="outline" className="absolute end-0 top-0 opacity-0 group-hover/description:opacity-100 focus-visible:opacity-100" onClick={() => (setMode("write"), setEditing(pr.body ?? ""))}>
          Edit
        </Button>
      )}
      {pr.body?.trim() ? <Body text={pr.body} keep={`pr-${pr.id}-body`} /> : <p className="text-muted-foreground">No description provided</p>}
      {pr.node && <Reactions pr={pr} subject={pr.node} reactions={pr.reactions} onChanged={sends.onChanged} />}
    </section>
  );
}

const FILTERS = [
  { value: "all", label: "All activity" },
  { value: "comments", label: "All comments" },
  { value: "human", label: "Human comments" },
  { value: "commits", label: "Commits" },
] as const;
type Filter = (typeof FILTERS)[number]["value"];

/** A line on the Activity timeline: its icon, who did what and when. */
function EventLine({ icon, children, at, sends }: { icon: ReactNode; children: ReactNode; at: number | null; sends: Sends }) {
  return (
    <div className="flex min-h-6 items-center gap-3 text-sm text-muted-foreground">
      <span aria-hidden className="flex size-6 shrink-0 items-center justify-center svg:size-icon-sm">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        {children}
        {at !== null && <span className="ms-1.5 text-xs whitespace-nowrap">{ago(at, sends.now)}</span>}
      </span>
    </div>
  );
}

const Actor = ({ who }: { who: string | null }) => <span className="font-medium text-foreground">{who ?? "Someone"}</span>;

const DID: Partial<Record<PrItem["kind"], string>> = {
  closed: "closed this pull request",
  reopened: "reopened this pull request",
  ready: "marked this pull request as ready for review",
  draft: "converted this pull request to draft",
  force_pushed: "force-pushed the branch",
  merged: "merged this pull request",
};

/** One timeline entry, in words [D165]. */
function Entry({ item, pr, comments, sends, filter, onAddToChat }: { item: PrItem; pr: PullRequest; comments: Map<string, PrComment>; sends: Sends; filter: Filter; onAddToChat: (c: PrComment) => void }) {
  const talk = filter === "comments" || filter === "human";
  if (filter === "commits" && item.kind !== "commits") return null;
  if (talk && item.kind !== "comment" && item.kind !== "review") return null;
  if (filter === "human" && item.bot) return null;
  switch (item.kind) {
    case "commits":
      return (
        <Collapsible>
          <CollapsibleTrigger className="group flex min-h-6 w-full cursor-pointer items-center gap-3 rounded-control text-start text-sm text-muted-foreground hover:text-foreground focus-visible:focus-ring">
            <span className="flex size-6 items-center justify-center svg:size-icon-sm">
              <Commit />
            </span>
            {item.commits.length} commit{item.commits.length === 1 ? "" : "s"}
            <ChevronRight className="size-icon-xs transition-transform group-data-panel-open:rotate-90" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="ms-9 flex flex-col gap-1 pt-1">
              {item.commits.map((commit) => (
                <li key={commit.sha} className="flex min-w-0 items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-foreground">{commit.message.split("\n")[0]}</span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{commit.sha.slice(0, 7)}</span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      );
    case "comment": {
      const comment = comments.get(item.id);
      return comment ? <CommentCard pr={pr} comment={comment} sends={sends} onAddToChat={onAddToChat} /> : null;
    }
    case "review": {
      const body = item.said ? comments.get(item.id) : undefined;
      const words = item.state === "approved" ? "approved these changes" : item.state === "changes" ? "requested changes" : "reviewed";
      return (
        <div className="flex flex-col gap-2">
          {body ? (
            <CommentCard pr={pr} comment={body} did={words} sends={sends} onAddToChat={onAddToChat} />
          ) : (
            <EventLine icon={item.state === "approved" ? <Check className="text-success" /> : <Eye />} at={item.atMs} sends={sends}>
              <Actor who={item.actor} /> {words}
            </EventLine>
          )}
          {item.threads.length > 0 && (
            <div className="ms-9 flex flex-col gap-2">
              {item.threads.map((thread) => (
                <ThreadCard key={thread.id} pr={pr} thread={thread} comments={comments} sends={sends} onAddToChat={onAddToChat} />
              ))}
            </div>
          )}
        </div>
      );
    }
    case "requested":
      return (
        <EventLine icon={<Eye />} at={item.atMs} sends={sends}>
          <Actor who={item.actor} /> requested a review from {item.who.filter(Boolean).join(", ")}
        </EventLine>
      );
    case "dismissed":
      return (
        <EventLine icon={<Eye />} at={item.atMs} sends={sends}>
          <Actor who={item.actor} /> dismissed {item.who ?? "a"} review
        </EventLine>
      );
    case "deployed":
      return (
        <EventLine icon={<ChevronRight />} at={item.atMs} sends={sends}>
          <Actor who={item.actor} /> deployed to {item.env ?? "an environment"}
        </EventLine>
      );
    case "mentioned":
      return (
        <EventLine icon={<ChevronRight />} at={item.atMs} sends={sends}>
          <Actor who={item.actor} /> mentioned this in {item.url ? <button type="button" className="cursor-pointer text-foreground hover:underline" onClick={() => sends.onOpen({ url: item.url! })}>#{item.number} {item.title}</button> : `#${item.number}`}
        </EventLine>
      );
    case "deleted":
      return (
        <EventLine icon={<Branch />} at={item.atMs} sends={sends}>
          <Actor who={item.actor} /> deleted the {item.branch ?? "head"} branch
        </EventLine>
      );
    default:
      return (
        <EventLine icon={<Branch />} at={item.atMs} sends={sends}>
          <Actor who={item.actor} /> {DID[item.kind]}
        </EventLine>
      );
  }
}

/** Activity: its filter, opened by, the timeline, auto-merge, then Leave a comment [D165]. */
function Activity({ pr, sends, onAddToChat }: { pr: PullRequest; sends: Sends; onAddToChat: (c: PrComment) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const comments = new Map(pr.comments.map((comment) => [comment.id, comment]));
  const items = pr.timeline ?? [];
  return (
    <section id="pull-request-activity" className="flex min-w-0 flex-col gap-3 border-t border-border pt-6">
      <div className="flex items-center justify-between gap-2 text-base select-none">
        <h2 className="font-semibold text-foreground">Activity</h2>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger aria-label="Filter activity" title={FILTERS.find((each) => each.value === filter)!.label} className={cx("flex size-control-sm cursor-pointer items-center justify-center rounded-capsule hover:bg-fill hover:text-foreground focus-visible:focus-ring aria-expanded:bg-fill svg:size-icon-md", filter === "all" ? "text-muted-foreground" : "text-foreground")}>
            <Filter />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={filter} onValueChange={(value: Filter) => setFilter(value)}>
              {FILTERS.map((each) => (
                <DropdownMenuRadioItem key={each.value} value={each.value}>
                  {each.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-col gap-2">
        {filter === "all" && (
          <EventLine icon={<Avatar login={pr.openedBy} at={pr.checkedAtMs} size="size-5" />} at={pr.openedAtMs} sends={sends}>
            <Actor who={pr.openedBy} /> opened this pull request
          </EventLine>
        )}
        {items.map((item) => (
          <Entry key={item.id} item={item} pr={pr} comments={comments} sends={sends} filter={filter} onAddToChat={onAddToChat} />
        ))}
        {filter === "all" && pr.autoMerge && (
          <EventLine icon={<Check className="text-success" />} at={null} sends={sends}>
            Automerge enabled — the branch will merge when all requirements are met.
          </EventLine>
        )}
      </div>
      <Writer label="Leave a comment" placeholder="Leave a comment" verb="Comment" mentions={pr.ref} onSend={(text) => prAct("comment", pr.ref!, ...said(text)).finally(sends.onChanged)} />
    </section>
  );
}

/**
 * A pull request's Summary [D164 D165]: up to 6xl wide, at 800 and over two columns, the heading and then
 * the description and Activity on the left, PR details on the right (300 wide); one column under that.
 */
export function Summary({ pr, sends, onFix, onAddToChat }: { pr: PullRequest; sends: Sends; onFix: (focus: "checks" | "conflicts" | "comments", check?: string) => void; onAddToChat: (c: PrComment) => void }) {
  return (
    <div className="@container/pr-page">
      <div className="pr-page relative mx-auto w-full max-w-6xl min-w-0 px-6 pb-dock">
        <div data-pr-heading className="relative flex min-w-0 flex-col gap-2 select-text">
          <Heading pr={pr} sends={sends} />
        </div>
        <div data-pr-aside className="min-w-0">
          <PrAside pr={pr} sends={sends} onFix={onFix} />
        </div>
        <div data-pr-body className="flex min-w-0 flex-col gap-8 select-text">
          <Description pr={pr} sends={sends} />
          <Activity pr={pr} sends={sends} onAddToChat={onAddToChat} />
        </div>
      </div>
    </div>
  );
}
