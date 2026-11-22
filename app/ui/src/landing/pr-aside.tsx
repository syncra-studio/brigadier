import { type ReactNode, useEffect, useState } from "react";

import { Button } from "../components/button";
import { CheckboxRow } from "../components/checkbox-row";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../components/context-menu";
import { cx } from "../components/cx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { Input } from "../components/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/menu";
import { showToast } from "../components/toast";
import { ask, useDaemon } from "../daemon";
import { CheckCircle, ChevronDown, ChevronRight, DotsHorizontal, Minus, Spinner } from "../icons";
import { Comment } from "../icons/sidebar";
import { Line } from "../panel/source/rows";
import { openPrPage } from "../pull-requests/route";
import { Clock, PullRequestOpen, XCircle } from "./icons";
import { prAct } from "./pr-act";
import { Avatar, type Sends } from "./pr-parts";
import type { PrCheck, PullRequest } from "./pull-requests";

type Fix = (focus: "checks" | "conflicts" | "comments", check?: string) => void;

/**
 * A section of the PR page's right column [D238]: its muted 28-tall title folds it, a chevron after it on
 * hover while open and turned while folded, `summary` after it then; `after` ends the title row. No card: its rows'
 * hover bleeds 8 past the column.
 */
function Section({ title, summary, after, children }: { title: ReactNode; summary?: ReactNode; after?: ReactNode; children?: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="flex min-w-0 flex-col">
      <header className="flex h-7 min-w-0 items-center gap-2 pb-0.5 text-sm text-muted-foreground">
        {children ? (
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="group/section-toggle inline-flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-xl py-0.5 text-start focus-visible:focus-ring">
            <span className="truncate">{title}</span>
            <ChevronDown aria-hidden className={cx("size-icon-xs shrink-0 transition-transform motion-reduce:transition-none", open ? "opacity-0 group-hover/section-toggle:opacity-100 group-focus-visible/section-toggle:opacity-100" : "-rotate-90")} />
            {!open && summary && <span className="ms-auto flex min-w-0 items-center gap-1">{summary}</span>}
          </button>
        ) : (
          <h3 className="min-w-0 flex-1 truncate select-none">{title}</h3>
        )}
        {after && <div className="relative flex shrink-0">{after}</div>}
      </header>
      {children && open && <div className="-mx-2 flex min-w-0 flex-col gap-0.5">{children}</div>}
    </section>
  );
}

/** Five rows, then Show more / Show less. */
function Five({ children }: { children: ReactNode[] }) {
  const [all, setAll] = useState(false);
  return (
    <>
      {all ? children : children.slice(0, 5)}
      {children.length > 5 && (
        <Line onClick={() => setAll(!all)} className="text-muted-foreground">
          {all ? "Show less" : "Show more"}
        </Line>
      )}
    </>
  );
}

const CHECK_ICON: Record<PrCheck["state"], ReactNode> = {
  failed: <XCircle className="text-destructive" />,
  running: <Spinner className="text-pr-yellow motion-safe:animate-spin" />,
  passed: <CheckCircle className="text-success" />,
  skipped: <Minus className="text-faint-foreground" />,
};
const CHECK_WORDS = { failed: "Failed test", running: "Check running", passed: "Passed test", skipped: "Skipped test" };

const REVIEW_ICON = {
  approved: <CheckCircle className="text-success" />,
  changes: <XCircle className="text-destructive" />,
  commented: <Comment className="text-faint-foreground" />,
  requested: <Clock className="text-pr-yellow" />,
};
const REVIEW_WORDS = { approved: "Approved", changes: "Changes requested", commented: "Commented", requested: "Waiting for review" };

/** Request reviewers: GitHub's people for the PR as you type, checked ones asked at once [D165]. */
function RequestReviewers({ pr, open, onOpenChange, onDone }: { pr: PullRequest; open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<{ login: string; name: string | null }[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => ask({ op: "run", args: ["host", "@", "users", pr.ref!, text] }, (reply) => setFound(reply.ok ? reply.users : [])), 250);
    return () => clearTimeout(timer);
  }, [open, text]);
  const asked = new Set(pr.reviewers.map((r) => r.login));
  const send = () => {
    setBusy(true);
    setError(null);
    prAct("reviewers", pr.ref!, "add", ...picked)
      .then(() => (setPicked([]), onOpenChange(false)), (cause: Error) => setError(cause.message))
      .finally(() => (setBusy(false), onDone()));
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request reviewers</DialogTitle>
        </DialogHeader>
        <Input autoFocus aria-label="Request review from" placeholder="Request review from…" value={text} onChange={(event) => setText(event.target.value)} />
        <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
          {found
            .filter((each) => each.login !== pr.openedBy)
            .map((each) => (
              <CheckboxRow
                key={each.login}
                label={each.login}
                note={each.name}
                checked={asked.has(each.login) || picked.includes(each.login)}
                disabled={asked.has(each.login) || busy}
                onCheckedChange={(on) => setPicked((now) => (on ? [...now, each.login] : now.filter((login) => login !== each.login)))}
              />
            ))}
          {!found.length && <p className="text-sm text-muted-foreground">No one found</p>}
        </div>
        <ErrorLine error={error} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || !picked.length} onClick={send}>
            Request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The PRs stacked under and over this one, as Rust reads them; none, no row. */
function useStack(pr: PullRequest): { ref: string; number: number; title: string; state: string }[] {
  const { daemon } = useDaemon();
  const [stack, setStack] = useState<{ ref: string; number: number; title: string; state: string }[]>([]);
  useEffect(() => {
    if (!daemon || !pr.ref) return;
    ask({ op: "run", args: ["host", "@", "stack", pr.ref] }, (reply) => reply.ok && setStack([...reply.stack.below, ...reply.stack.above]));
  }, [daemon, pr.ref, pr.head]);
  return stack;
}

/**
 * The right column [D165 D238]: Stack, Comments (hidden with none), Reviewers (right-click Remove me or
 * Re-request review; ⋯ Manage reviewers), Checks (Fix on a failing one, Fix all) and Merge conflicts (Fix). Fix asks
 * the review chat [D174].
 */
export function PrAside({ pr, sends, onFix }: { pr: PullRequest; sends: Sends; onFix: Fix }) {
  const [requesting, setRequesting] = useState(false);
  const [resolvedShown, setResolvedShown] = useState(false);
  const stack = useStack(pr);
  const reviewers = (verb: "remove" | "rerequest", login: string) =>
    prAct("reviewers", pr.ref!, verb, login)
      .catch((cause: Error) => showToast(cause.message, { tone: "error" }))
      .finally(sends.onChanged);
  const failed = pr.checks.filter((check) => check.state === "failed");
  const running = pr.checks.filter((check) => check.state === "running").length;
  const threads = (pr.timeline ?? []).flatMap((item) => (item.kind === "review" ? item.threads : []));
  const open = threads.filter((thread) => !thread.resolved);
  const resolved = threads.filter((thread) => thread.resolved);
  const conflicts = Boolean(pr.blockers?.conflicts) || pr.mergeState === "dirty";
  const fix = (focus: Parameters<Fix>[0], check?: string) => (
    <Button size="xs" variant="soft" onClick={() => onFix(focus, check)}>
      {focus === "checks" && !check ? "Fix all" : "Fix"}
    </Button>
  );
  const comments = new Map(pr.comments.map((comment) => [comment.id, comment]));
  const threadRow = (thread: (typeof threads)[number]) => {
    const first = comments.get(thread.comments[0]!);
    return (
      first && (
        <Line key={thread.id} icon={<Avatar login={first.author} at={pr.checkedAtMs} size="size-4" />} onClick={() => first.url && sends.onOpen({ url: first.url })}>
          {first.body.split("\n")[0]}
        </Line>
      )
    );
  };
  const manage = pr.state === "open" && writable(pr);
  return (
    <aside aria-label="PR details" className="flex min-w-0 flex-col gap-4">
      <h2 className="sr-only">PR details</h2>
      {stack.length > 0 && (
        <Section title="Stack" summary={`${stack.length}`}>
          <Five>
            {stack.map((each) => (
              <Line key={each.ref} icon={<PullRequestOpen className="text-faint-foreground" />} end={`#${each.number}`} onClick={() => openPrPage(each.ref)}>
                {each.title}
              </Line>
            ))}
          </Five>
        </Section>
      )}
      {threads.length > 0 && (
        <Section title="Comments" summary={open.length ? `${open.length} unresolved` : `${resolved.length} resolved`} after={open.length > 0 && fix("comments")}>
          <Five>{open.map(threadRow)}</Five>
          {resolved.length > 0 && (
            <>
              <Line icon={<ChevronRight className={cx("transition-transform", resolvedShown && "rotate-90")} />} onClick={() => setResolvedShown(!resolvedShown)} className="text-muted-foreground">
                {resolved.length} resolved comment{resolved.length === 1 ? "" : "s"}
              </Line>
              {resolvedShown && <Five>{resolved.map(threadRow)}</Five>}
            </>
          )}
        </Section>
      )}
      <Section
        title={pr.reviewers.length ? "Reviewers" : "No reviewers"}
        summary={pr.reviewers.slice(0, 4).map((r) => (
          <Avatar key={r.login} login={r.login} at={pr.checkedAtMs} size="size-4" />
        ))}
        after={
          manage && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger render={<TooltipIconButton tooltip="Manage reviewers" size="icon-xs" className="text-muted-foreground hover:text-foreground" />}>
                <DotsHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setRequesting(true)}>Manage reviewers</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }
      >
        {pr.reviewers.length > 0 && (
          <Five>
            {pr.reviewers.map((r) => {
              const items = [
                r.login === pr.viewer && r.state === "requested" && (
                  <ContextMenuItem key="remove" onClick={() => reviewers("remove", r.login)}>
                    Remove me
                  </ContextMenuItem>
                ),
                r.state !== "requested" && pr.state === "open" && pr.authored && (
                  <ContextMenuItem key="rerequest" onClick={() => reviewers("rerequest", r.login)}>
                    Re-request review
                  </ContextMenuItem>
                ),
              ].filter(Boolean);
              const line = (
                <Line icon={<span title={REVIEW_WORDS[r.state]} className="flex">{REVIEW_ICON[r.state]}</span>}>
                  <span className="flex min-w-0 items-center gap-2">
                    <Avatar login={r.login} at={pr.checkedAtMs} size="size-4" />
                    <span className="truncate">{r.login}</span>
                  </span>
                </Line>
              );
              return items.length ? (
                <ContextMenu key={r.login}>
                  <ContextMenuTrigger render={<div className="rounded-sm" />}>{line}</ContextMenuTrigger>
                  <ContextMenuContent>{items}</ContextMenuContent>
                </ContextMenu>
              ) : (
                <div key={r.login}>{line}</div>
              );
            })}
          </Five>
        )}
      </Section>
      <Section
        title={pr.checks.length ? "Checks" : "No checks reported"}
        summary={
          <>
            <span className="flex svg:size-icon-sm">{failed.length ? CHECK_ICON.failed : running ? CHECK_ICON.running : CHECK_ICON.passed}</span>
            {failed.length ? `${failed.length} failing` : running ? `${running} running` : "Passed"}
          </>
        }
        after={failed.length > 1 && fix("checks")}
      >
        {pr.checks.length > 0 && (
          <Five>
            {[...failed, ...pr.checks.filter((check) => check.state !== "failed")].map((check) => (
              <Line key={check.id} title={CHECK_WORDS[check.state]} icon={CHECK_ICON[check.state]} onClick={() => sends.onOpen({ check: check.id })} action={check.state === "failed" ? fix("checks", check.id) : undefined}>
                {check.name}
              </Line>
            ))}
          </Five>
        )}
      </Section>
      {conflicts && pr.state === "open" && (
        <Section title="Merge conflicts" after={fix("conflicts")}>
          <p className="px-2 text-sm text-muted-foreground">This branch has conflicts with {pr.base}. Resolve them before merging.</p>
        </Section>
      )}
      <RequestReviewers pr={pr} open={requesting} onOpenChange={setRequesting} onDone={sends.onChanged} />
    </aside>
  );
}

/** Who may ask for reviewers: whoever may edit it, or its author. */
const writable = (pr: PullRequest) => Boolean(pr.ref) && (pr.canEdit || pr.authored);
