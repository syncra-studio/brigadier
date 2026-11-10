import { useEffect, useSyncExternalStore } from "react";

import { Button } from "../../components/button";
import { CheckboxRow } from "../../components/checkbox-row";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/collapsible";
import { ErrorLine } from "../../components/error-line";
import { Input } from "../../components/input";
import { Skeleton } from "../../components/skeleton";
import { Textarea } from "../../components/textarea";
import { showToast, toastManager } from "../../components/toast";
import { ConfirmForm } from "../../components/confirm-dialog";
import { ask, useDaemon } from "../../daemon";
import type { Pr } from "../types";
import type { ActionPick } from "./action-menus";
import { Confirm, type Held } from "./dialogs";

/**
 * A session's PR facts as the host module reads them [D1030]: the host's name (null for one it doesn't know), whether
 * its CLI can make the PR, the base and branch, and the text to start from.
 */
export type HostInfo = { host: string | null; cli: boolean; base: string; branch: string; title: string; body: string; prs?: Pr[] | null };

/** What the action menu offers for a PR [D1030]: Create PR through the host's CLI, its page, neither, or not known yet. */
export type PrWay = "cli" | "page" | "none" | "loading";

export const prWay = (info: HostInfo | null | undefined): PrWay => (info === undefined ? "loading" : !info?.host ? "none" : info.cli ? "cli" : "page");

/** The dialog's text, kept per session through a failure or a close [D30]. */
type Text = { title: string; body: string; draft: boolean };

/** Create PR's dialog [D1030, D1085, D1100]: the title, the description, draft, into the session's base. */
export function CreatePrDialog({ open, info, text, busy = null, error = null, offline = false, held, onText, onRetry, onCancel, onConfirm }: {
  open: boolean;
  /** Undefined while Rust reads it. */
  info: HostInfo | undefined;
  text: Text;
  /** Making it, or finding out whether a create whose answer was lost made one. */
  busy?: "creating" | "checking" | null;
  error?: string | null;
  offline?: boolean;
  held?: Held;
  onText: (text: Text) => void;
  /** Reads the host again after a failed read (no `info`, an `error`). */
  onRetry?: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const working = busy !== null;
  const [said, details] = split(error);
  return (
    <Confirm open={open} onOpenChange={(next) => !next && !working && onCancel()} held={held}>
      <ConfirmForm
        title="Create pull request"
        description={
          info ? (
            <>
              <span className="font-mono text-foreground">{info.branch}</span> into <span className="font-mono text-foreground">{info.base}</span> on {info.host}. It's pushed first.
            </>
          ) : error ? (
            "Couldn't read where this branch goes."
          ) : (
            <Skeleton className="h-4 w-56" />
          )
        }
        confirm={busy === "checking" ? "Checking…" : "Create PR"}
        busy={working}
        disabled={!info || offline || !text.title.trim()}
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        <div className="flex flex-col gap-2">
          <Input aria-label="Title" placeholder={info ? "Title" : error ? "" : "Loading…"} value={text.title} disabled={!info || working} onValueChange={(title: string) => onText({ ...text, title })} />
          <Textarea aria-label="Description" placeholder={info ? "Description" : ""} value={text.body} disabled={!info || working} onChange={(event) => onText({ ...text, body: event.target.value })} />
          <CheckboxRow label="Create as draft" checked={text.draft} disabled={!info || working} onCheckedChange={(draft) => onText({ ...text, draft })} />
          <Collapsible>
            <ErrorLine
              error={offline ? "Brigadier isn't connected. This waits until it is." : said}
              actions={
                !offline && details ? (
                  <CollapsibleTrigger render={<Button variant="ghost" size="xs" />}>Details</CollapsibleTrigger>
                ) : !info && !offline && onRetry ? (
                  <Button variant="ghost" size="xs" onClick={onRetry}>Try again</Button>
                ) : undefined
              }
            />
            {details && (
              <CollapsibleContent>
                <pre className="mt-1 max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">{details}</pre>
              </CollapsibleContent>
            )}
          </Collapsible>
        </div>
      </ConfirmForm>
    </Confirm>
  );
}

/** Rust's error: a plain sentence, then (after a blank line) what the tool itself said, for Details. */
const split = (error: string | null | undefined) => {
  const at = error?.indexOf("\n\n") ?? -1;
  return at < 0 ? [error, ""] : [error!.slice(0, at), error!.slice(at + 2)];
};

const EMPTY: Text = { title: "", body: "", draft: false };

/**
 * One session's PR work, kept here rather than in the view, so a create or push that outlives Source (the panel
 * closed, another session opened) still lands its answer and shows it on return [D30]. `info` is undefined until Rust
 * reads it and null for no known host; `text` null until edited, so it follows Rust's; `uncertain`: a create went out
 * and lost its answer, so the host is asked before another. `prs`: the branch's PRs as last read, a made one added at once.
 */
type Op = { info: HostInfo | null | undefined; readError: string | null; text: Text | null; open: boolean; busy: "creating" | "checking" | null; error: string | null; uncertain: boolean; prs: Pr[] };

const NONE: Op = { info: null, readError: null, text: null, open: false, busy: null, error: null, uncertain: false, prs: [] };
const ops = new Map<string, Op>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const opOf = (session: string): Op => {
  if (!ops.has(session)) ops.set(session, { ...NONE, info: undefined });
  return ops.get(session)!;
};
const put = (session: string, next: Partial<Op>) => {
  ops.set(session, { ...opOf(session), ...next });
  for (const listener of listeners) listener();
};
const textOf = (op: Op): Text => op.text ?? (op.info ? { title: op.info.title, body: op.info.body, draft: false } : EMPTY);
const LOST = "Brigadier isn't connected. This waits until it is.";

// A push or create moves refs the watch may not follow (a new upstream), so Source's sync count reads git again after each.
const run = (session: string, args: string[], onReply: (reply: Record<string, any>) => void) =>
  ask({ op: "run", args: ["host", session, ...args] }, (reply) => {
    if (args[0] !== "info" && args[0] !== "find") ask({ op: "git_refresh" });
    onReply(reply);
  });

function read(session: string) {
  run(session, ["info"], (reply) => {
    if (reply.error === "disconnected") return;
    // Null PRs: gh couldn't say, so the last ones stay.
    if (reply.ok) return put(session, { info: reply.info, readError: null, ...(reply.info.prs && { prs: reply.info.prs }) });
    // A failed read keeps what was read before; with nothing before, no PR rows [D1030] and the dialog says why.
    const before = opOf(session).info;
    put(session, { info: before === undefined ? null : before, readError: reply.error });
  });
}

/**
 * The message writer's title and body [D1029], replacing git's own text while the user hasn't edited it; when it
 * writes nothing, git's text stays (proposed, D1164).
 */
function draft(session: string) {
  ask({ op: "run", args: ["source", session, "write", "pr"] }, (reply) => {
    if (!reply.ok || opOf(session).text !== null) return;
    const [title = "", ...body] = String(reply.text).split("\n");
    put(session, { text: { title: title.trim(), body: body.join("\n").trim(), draft: false } });
  });
}

function made(session: string, pr: { number: number | null; url: string }) {
  const op = opOf(session);
  // Shown in Source's PR icon at once, then read again for its real state.
  const shown: Pr[] = pr.number ? [{ number: pr.number, title: textOf(op).title, state: "open", health: "running", failed: 0 }] : [];
  put(session, { uncertain: false, text: null, busy: null, open: false, error: null, prs: [...shown, ...op.prs.filter((each) => each.number !== pr.number)] });
  read(session);
  // Proposed words.
  showToast(pr.number ? `Opened #${pr.number}` : "Opened the pull request", { tone: "success", stays: true, actions: [{ label: "Open ↗", run: () => window.open(pr.url) }] });
}

function create(session: string) {
  const text = textOf(opOf(session));
  put(session, { busy: "creating", error: null });
  run(session, ["create", "--title", text.title, "--body", text.body, ...(text.draft ? ["--draft"] : [])], (reply) => {
    if (reply.ok) return made(session, reply.pr);
    const lost = reply.error === "disconnected";
    put(session, { busy: null, uncertain: lost || opOf(session).uncertain, error: lost ? "Brigadier lost its connection. It checks whether the PR was made before making another." : reply.error });
  });
}

function confirm(session: string) {
  if (!opOf(session).uncertain) return create(session);
  put(session, { busy: "checking", error: null });
  run(session, ["find"], (reply) => {
    if (reply.ok && reply.pr) return made(session, reply.pr);
    if (reply.ok) {
      put(session, { uncertain: false });
      return create(session);
    }
    put(session, { busy: null, error: reply.error === "disconnected" ? LOST : reply.error });
  });
}

/** Push branch, and Open PR page ↗ after it; a toast says it's under way, then how it went. */
function push(session: string, page: boolean) {
  const op = opOf(session);
  const branch = op.info?.branch ?? "the branch";
  const text = textOf(op);
  const pending = showToast(`Pushing ${branch}…`, { stays: true });
  run(session, page ? ["link", "--title", text.title, "--body", text.body] : ["push"], (reply) => {
    toastManager.close(pending);
    if (!reply.ok) {
      if (reply.error === "disconnected") return showToast("Brigadier isn't connected.", { tone: "error" });
      const [said, details] = split(reply.error);
      return showToast(said!, { tone: "error", actions: details ? [{ label: "Details", run: () => showToast(details, { tone: "error", stays: true }) }] : [] });
    }
    // Past the click, so window.open would be blocked: main opens it [D1142].
    if (page) window.brigadier?.openLink(reply.url);
    else showToast(`Pushed ${branch}`, { tone: "success" });
  });
}

/**
 * The action menu's PR rows for a session, wired [D1030]: Create PR… opens its dialog, Push branch pushes, and Open
 * PR page ↗ pushes then opens the host's page. Every move shows at once and Rust's answer settles it [D30].
 */
export function useCreatePr(session: string | null) {
  const connected = !!useDaemon().daemon;
  const op = useSyncExternalStore(subscribe, () => (session ? opOf(session) : NONE));
  useEffect(() => {
    if (session && connected) read(session);
  }, [session, connected]);

  const onPick = (pick: ActionPick) => {
    if (!session) return;
    if (pick === "createPr") {
      put(session, { open: true, error: op.busy ? op.error : null });
      if (connected) read(session);
      if (connected && op.text === null && !op.busy) draft(session);
    } else if (pick === "pushBranch") push(session, false);
    else if (pick === "openPrPage") push(session, true);
  };

  const dialog = session && (
    <CreatePrDialog
      open={op.open}
      info={op.info ?? undefined}
      text={textOf(op)}
      busy={op.busy}
      error={op.error ?? (op.info ? null : op.readError)}
      offline={!connected}
      onText={(text) => put(session, { text })}
      onRetry={() => read(session)}
      onCancel={() => put(session, { open: false })}
      onConfirm={() => confirm(session)}
    />
  );
  // A read that failed with nothing before it still offers Create PR…, whose dialog says why and tries again [D30].
  const way: PrWay = !session || (op.info === null && op.readError) ? "cli" : prWay(op.info);
  return { way, onPick, dialog, prs: op.prs };
}
