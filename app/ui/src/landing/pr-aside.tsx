import { type ReactNode, useEffect, useState } from "react";

import { Button } from "../components/button";
import { CheckboxRow } from "../components/checkbox-row";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { cx } from "../components/cx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { Input } from "../components/input";
import { showToast } from "../components/toast";
import { ask, useDaemon } from "../daemon";
import { CheckCircle, ChevronRight, Minus, Warning } from "../icons";
import { Comment } from "../icons/sidebar";
import { Eye } from "../icons/settings";
import { openPrPage } from "../pull-requests/route";
import { Clock, PullRequestOpen, XCircle } from "./icons";
import { prAct } from "./pr-act";
import { Avatar, type Sends } from "./pr-parts";
import type { PrCheck, PullRequest } from "./pull-requests";

type Fix = (focus: "checks" | "conflicts" | "comments", check?: string) => void;

/** A PR details row: 40 tall, its icon, label and pill, folding its body (indented under the label) [D165]. */
function Row({ icon, label, pill, action, children, open = false }: { icon: ReactNode; label: string; pill?: ReactNode; action?: ReactNode; children?: ReactNode; open?: boolean }) {
  return (
    <Collapsible defaultOpen={open} className="border-t border-border first:border-t-0">
      <div className="flex h-10 items-center gap-2 px-4">
        <CollapsibleTrigger disabled={!children} className="group flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-start text-sm focus-visible:focus-ring disabled:cursor-default svg:size-icon-sm">
          <span className="flex text-muted-foreground">{icon}</span>
          <span className="shrink-0 font-medium text-foreground">{label}</span>
          <span className="ms-auto min-w-0 truncate text-end text-xs text-muted-foreground">{pill}</span>
          {children && <ChevronRight className="size-icon-xs text-muted-foreground transition-transform group-data-panel-open:rotate-90" />}
        </CollapsibleTrigger>
        {action}
      </div>
      {children && <CollapsibleContent className="flex flex-col gap-1 ps-10 pe-4 pb-3 text-sm">{children}</CollapsibleContent>}
    </Collapsible>
  );
}

const CHECK_ICON: Record<PrCheck["state"], ReactNode> = {
  failed: <XCircle className="text-destructive" />,
  running: <Clock className="text-pr-yellow" />,
  passed: <CheckCircle className="text-success" />,
  skipped: <Minus className="text-muted-foreground" />,
};

const REVIEW_PILL = { approved: "Approved", changes: "Rejected", commented: "Commented", requested: "Waiting for approval" };

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
 * PR details, a card beside the Summary [D165]: Reviewers (Request reviewers, Re-request review, Remove me),
 * Checks (Fix on a failing one, Fix all), Comments (unresolved, Fix), Stack, and Merge conflicts (Fix). Fix asks the
 * review chat beside it [D174].
 */
export function PrAside({ pr, sends, onFix }: { pr: PullRequest; sends: Sends; onFix: Fix }) {
  const [requesting, setRequesting] = useState(false);
  const stack = useStack(pr);
  const reviewers = (verb: "remove" | "rerequest", login: string) =>
    prAct("reviewers", pr.ref!, verb, login)
      .catch((cause: Error) => showToast(cause.message, { tone: "error" }))
      .finally(sends.onChanged);
  const failed = pr.checks.filter((check) => check.state === "failed");
  const running = pr.checks.filter((check) => check.state === "running").length;
  const review = pr.reviewers.some((r) => r.state === "changes") ? "changes" : pr.reviewers.some((r) => r.state === "approved") ? "approved" : pr.reviewers.length ? "requested" : null;
  const threads = (pr.timeline ?? []).flatMap((item) => (item.kind === "review" ? item.threads : []));
  const open = threads.filter((thread) => !thread.resolved);
  const conflicts = Boolean(pr.blockers?.conflicts) || pr.mergeState === "dirty";
  const fix = (focus: Parameters<Fix>[0], check?: string) => (
    <Button size="xs" variant="soft" onClick={() => onFix(focus, check)}>
      {focus === "checks" && !check ? "Fix all" : "Fix"}
    </Button>
  );
  const comments = new Map(pr.comments.map((comment) => [comment.id, comment]));
  return (
    <aside aria-label="PR details" className="overflow-clip rounded-menu border border-border">
      <h2 className="sr-only">PR details</h2>
      <Row
        icon={<Eye />}
        label="Reviewers"
        pill={review ? REVIEW_PILL[review] : "No reviewers"}
        open={pr.reviewers.length > 0}
        action={
          pr.state === "open" && (
            <Button size="xs" variant="ghost" onClick={() => setRequesting(true)}>
              {pr.reviewers.length ? "Manage" : "Add"}
            </Button>
          )
        }
      >
        {pr.reviewers.map((r) => (
          <div key={r.login} className="group/reviewer flex min-h-7 items-center gap-2">
            <Avatar login={r.login} at={pr.checkedAtMs} size="size-4" />
            <span className="min-w-0 flex-1 truncate text-foreground">{r.login}</span>
            {r.login === pr.viewer && r.state === "requested" ? (
              <Button size="xs" variant="ghost" onClick={() => reviewers("remove", r.login)}>
                Remove me
              </Button>
            ) : r.state !== "requested" && pr.state === "open" && pr.authored ? (
              <Button size="xs" variant="ghost" className="hidden group-hover/reviewer:flex" onClick={() => reviewers("rerequest", r.login)}>
                Re-request review
              </Button>
            ) : null}
            <span className={cx("shrink-0 text-xs", r.state === "approved" ? "text-success" : r.state === "changes" ? "text-destructive" : "text-muted-foreground")}>{REVIEW_PILL[r.state]}</span>
          </div>
        ))}
      </Row>
      <Row
        icon={failed.length ? CHECK_ICON.failed : running ? CHECK_ICON.running : CHECK_ICON.passed}
        label="Checks"
        pill={!pr.checks.length ? "No checks reported" : failed.length ? `${failed.length} failing` : running ? `${running} running` : "Passed"}
        open={failed.length > 0}
        action={failed.length > 1 && fix("checks")}
      >
        {pr.checks.length > 0 &&
          [...failed, ...pr.checks.filter((check) => check.state !== "failed")].map((check) => (
            <div key={check.id} className="flex min-h-7 items-center gap-2 svg:size-icon-sm">
              <span className="flex">{CHECK_ICON[check.state]}</span>
              <button type="button" onClick={() => sends.onOpen({ check: check.id })} className="min-w-0 flex-1 cursor-pointer truncate text-start text-foreground hover:underline">
                {check.name}
              </button>
              {check.state === "failed" && fix("checks", check.id)}
            </div>
          ))}
      </Row>
      <Row icon={<Comment />} label="Comments" pill={open.length ? `${open.length} unresolved` : threads.length ? `${threads.length} resolved comment${threads.length === 1 ? "" : "s"}` : "No comments"} open={open.length > 0} action={open.length > 0 && fix("comments")}>
        {open.map((thread) => {
          const first = comments.get(thread.comments[0]!);
          return (
            first && (
              <button key={thread.id} type="button" onClick={() => first.url && sends.onOpen({ url: first.url })} className="flex min-h-7 min-w-0 cursor-pointer items-center gap-2 text-start hover:underline">
                <Avatar login={first.author} at={pr.checkedAtMs} size="size-4" />
                <span className="min-w-0 flex-1 truncate text-foreground">{first.body.split("\n")[0]}</span>
              </button>
            )
          );
        })}
      </Row>
      {stack.length > 0 && (
        <Row icon={<PullRequestOpen />} label="Stack" pill={`${stack.length} stacked PR${stack.length === 1 ? "" : "s"}`} open>
          {stack.map((each) => (
            <button key={each.ref} type="button" onClick={() => openPrPage(each.ref)} className="flex min-h-7 min-w-0 cursor-pointer items-center gap-2 text-start hover:underline">
              <span className="shrink-0 text-muted-foreground">#{each.number}</span>
              <span className="min-w-0 flex-1 truncate text-foreground">{each.title}</span>
            </button>
          ))}
        </Row>
      )}
      {conflicts && pr.state === "open" && (
        <Row icon={<Warning className="text-pr-yellow" />} label="Merge conflicts" action={fix("conflicts")} open>
          <p className="text-muted-foreground">This branch has conflicts with {pr.base}. Resolve them before merging.</p>
        </Row>
      )}
      <RequestReviewers pr={pr} open={requesting} onOpenChange={setRequesting} onDone={sends.onChanged} />
    </aside>
  );
}
