import { useEffect, useState } from "react";

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

const infos = new Map<string, HostInfo | null>();
const texts = new Map<string, Text>();
/** Sessions whose create went out and lost its answer: found with the host before another create [D30]. */
const uncertain = new Set<string>();

const run = (session: string, args: string[], onReply: (reply: Record<string, any>) => void) => ask({ op: "run", args: ["host", session, ...args] }, onReply);

/**
 * The action menu's PR rows for a session, wired [D1030]: Create PR… opens its dialog, Push branch pushes, and Open
 * PR page ↗ pushes then opens the host's page. Every move shows at once and Rust's answer settles it [D30].
 */
export function useCreatePr(session: string | null) {
  const connected = !!useDaemon().daemon;
  const [info, setInfo] = useState<HostInfo | null | undefined>(() => (session ? infos.get(session) : null));
  const [open, setOpen] = useState(false);
  const [text, setTextState] = useState<Text>({ title: "", body: "", draft: false });
  const [busy, setBusy] = useState<"creating" | "checking" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = () => {
    if (!session) return;
    run(session, ["info"], (reply) => {
      // An unknown remote, a session with no base: no PR rows, as with no host [D1030].
      const next: HostInfo | null = reply.ok ? reply.info : null;
      if (reply.error === "disconnected") return;
      infos.set(session, next);
      setInfo(next);
      if (next && !texts.has(session)) setTextState({ title: next.title, body: next.body, draft: false });
    });
  };
  useEffect(() => {
    if (!session) return;
    setInfo(infos.get(session));
    setTextState(texts.get(session) ?? { title: "", body: "", draft: false });
    if (connected) read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, connected]);

  const setText = (next: Text) => {
    setTextState(next);
    if (session) texts.set(session, next);
  };
  const made = (pr: { number: number | null; url: string }) => {
    if (!session) return;
    uncertain.delete(session);
    texts.delete(session);
    setBusy(null);
    setOpen(false);
    // Proposed words.
    showToast(pr.number ? `Opened #${pr.number}` : "Opened the pull request", { tone: "success", actions: [{ label: "Open ↗", run: () => window.open(pr.url) }] });
  };
  const create = () => {
    if (!session) return;
    setBusy("creating");
    run(session, ["create", "--title", text.title, "--body", text.body, ...(text.draft ? ["--draft"] : [])], (reply) => {
      if (reply.ok) return made(reply.pr);
      if (reply.error === "disconnected") uncertain.add(session);
      setBusy(null);
      setError(reply.error === "disconnected" ? "Brigadier lost its connection. It checks whether the PR was made before making another." : reply.error);
    });
  };
  const confirm = () => {
    if (!session) return;
    setError(null);
    if (!uncertain.has(session)) return create();
    setBusy("checking");
    run(session, ["find"], (reply) => {
      if (reply.ok && reply.pr) return made(reply.pr);
      if (reply.ok) {
        uncertain.delete(session);
        return create();
      }
      setBusy(null);
      setError(reply.error === "disconnected" ? "Brigadier isn't connected. This waits until it is." : reply.error);
    });
  };
  /** Push branch, and Open PR page ↗ after it; a toast says it's under way, then how it went. */
  const push = (page: boolean) => {
    if (!session) return;
    const branch = info?.branch ?? "the branch";
    const pending = showToast(`Pushing ${branch}…`);
    const args = page ? ["link", "--title", text.title, "--body", text.body] : ["push"];
    run(session, args, (reply) => {
      toastManager.close(pending);
      if (!reply.ok) return showToast(reply.error === "disconnected" ? "Brigadier isn't connected." : reply.error, { tone: "error" });
      if (page) window.open(reply.url);
      else showToast(`Pushed ${branch}`, { tone: "success" });
    });
  };

  const onPick = (pick: ActionPick) => {
    if (pick === "createPr") {
      setOpen(true);
      setError(null);
      if (connected) read();
    } else if (pick === "pushBranch") push(false);
    else if (pick === "openPrPage") push(true);
  };

  const dialog = (
    <CreatePrDialog
      open={open}
      info={info ?? undefined}
      text={text}
      busy={busy}
      error={error}
      offline={!connected}
      onText={setText}
      onCancel={() => setOpen(false)}
      onConfirm={confirm}
    />
  );
  return { way: session ? prWay(info) : ("cli" as PrWay), onPick, dialog };
}
