import { useEffect, useSyncExternalStore } from "react";

import { CheckboxRow } from "../../components/checkbox-row";
import { ErrorLine } from "../../components/error-line";
import { Input } from "../../components/input";
import { Skeleton } from "../../components/skeleton";
import { Textarea } from "../../components/textarea";
import { showToast, toastManager } from "../../components/toast";
import { ConfirmForm } from "../../components/confirm-dialog";
import { ask, useDaemon } from "../../daemon";
import type { ActionPick } from "./action-menus";
import { Confirm, type Held } from "./dialogs";

/**
 * A session's PR facts as the host module reads them [D1030]: the host's name (null for one it doesn't know), whether
 * its CLI can make the PR, the base and branch, and the text to start from.
 */
export type HostInfo = { host: string | null; cli: boolean; base: string; branch: string; title: string; body: string };

/** What the action menu offers for a PR [D1030]: Create PR through the host's CLI, its page, neither, or not known yet. */
export type PrWay = "cli" | "page" | "none" | "loading";

export const prWay = (info: HostInfo | null | undefined): PrWay => (info === undefined ? "loading" : !info?.host ? "none" : info.cli ? "cli" : "page");

/** The dialog's text, kept per session through a failure or a close [D30]. */
type Text = { title: string; body: string; draft: boolean };

/** Create PR's dialog [D1030, D1085, D1100]: the title, the description, draft, into the session's base. */
export function CreatePrDialog({ open, info, text, busy = null, error = null, offline = false, held, onText, onCancel, onConfirm }: {
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
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const working = busy !== null;
  return (
    <Confirm open={open} onOpenChange={(next) => !next && !working && onCancel()} held={held}>
      <ConfirmForm
        title="Create pull request"
        description={
          info ? (
            <>
              <span className="font-mono text-foreground">{info.branch}</span> into <span className="font-mono text-foreground">{info.base}</span> on {info.host}. It's pushed first.
            </>
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
          <Input aria-label="Title" placeholder={info ? "Title" : "Loading…"} value={text.title} disabled={!info || working} onValueChange={(title: string) => onText({ ...text, title })} />
          <Textarea aria-label="Description" placeholder={info ? "Description" : ""} value={text.body} disabled={!info || working} onChange={(event) => onText({ ...text, body: event.target.value })} />
          <CheckboxRow label="Create as draft" checked={text.draft} disabled={!info || working} onCheckedChange={(draft) => onText({ ...text, draft })} />
          <ErrorLine error={offline ? "Brigadier isn't connected. This waits until it is." : error} />
        </div>
      </ConfirmForm>
    </Confirm>
  );
}

const EMPTY: Text = { title: "", body: "", draft: false };

/**
 * One session's PR work, kept here rather than in the view, so a create or push that outlives Source (the panel
 * closed, another session opened) still lands its answer and shows it on return [D30]. `info` is undefined until Rust
 * reads it and null for no known host; `text` null until edited, so it follows Rust's; `uncertain`: a create went out
 * and lost its answer, so the host is asked before another.
 */
type Op = { info: HostInfo | null | undefined; text: Text | null; open: boolean; busy: "creating" | "checking" | null; error: string | null; uncertain: boolean };

const NONE: Op = { info: null, text: null, open: false, busy: null, error: null, uncertain: false };
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

const run = (session: string, args: string[], onReply: (reply: Record<string, any>) => void) => ask({ op: "run", args: ["host", session, ...args] }, onReply);

function read(session: string) {
  run(session, ["info"], (reply) => {
    if (reply.error === "disconnected") return;
    // An unknown remote, a session with no base: no PR rows, as with no host [D1030].
    put(session, { info: reply.ok ? reply.info : null });
  });
}

function made(session: string, pr: { number: number | null; url: string }) {
  put(session, { uncertain: false, text: null, busy: null, open: false, error: null });
  // Proposed words.
  showToast(pr.number ? `Opened #${pr.number}` : "Opened the pull request", { tone: "success", actions: [{ label: "Open ↗", run: () => window.open(pr.url) }] });
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
  const pending = showToast(`Pushing ${branch}…`);
  run(session, page ? ["link", "--title", text.title, "--body", text.body] : ["push"], (reply) => {
    toastManager.close(pending);
    if (!reply.ok) return showToast(reply.error === "disconnected" ? "Brigadier isn't connected." : reply.error, { tone: "error" });
    if (page) window.open(reply.url);
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
    } else if (pick === "pushBranch") push(session, false);
    else if (pick === "openPrPage") push(session, true);
  };

  const dialog = session && (
    <CreatePrDialog
      open={op.open}
      info={op.info ?? undefined}
      text={textOf(op)}
      busy={op.busy}
      error={op.error}
      offline={!connected}
      onText={(text) => put(session, { text })}
      onCancel={() => put(session, { open: false })}
      onConfirm={() => confirm(session)}
    />
  );
  return { way: session ? prWay(op.info) : ("cli" as PrWay), onPick, dialog };
}
