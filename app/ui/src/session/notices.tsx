import { type Key, useContext, useEffect, useState, useSyncExternalStore } from "react";

import { Button } from "../components/button";
import type { Draft } from "../components/composer/draft";
import { type Notice, Notices } from "../components/composer/rail";
import { openThread, type Row, useDaemon, useThread } from "../daemon";
import type { Item, SetupStep } from "../thread/item";
import { SessionOfThread } from "../accounts/limit";
import { ErrorAction } from "../components/thread/error-state";
import { answeringSource } from "./decisions";
import { retry, useStart } from "../home/start";
import { store } from "../onboarding/api";
import { askModel, type Retiring, useRetiring } from "./model";
import type { Source } from "../thread/thread";
import { daemonRun, failure, retryMessage, type Runner } from "./composer";
import { newId } from "./store";
import { putBack } from "./side";
import { useGitNotice } from "../panel/notice";

/**
 * A failed turn's actions on its row [D54]: what its reason offers, and Retry while it is the last turn and Rust
 * offers a rewind to it: back to its message, files kept, and it again in that attempt's place (D492). Shown at once
 * as under way; a refusal is said on the rail [D30].
 */
export function FailedActions({ turn, why }: { turn: string; why: Extract<Item, { reason: "failed" }>["why"] }) {
  const at = useContext(SessionOfThread);
  const session = useSyncExternalStore(answeringSource.subscribe, answeringSource.get);
  const retrying = retries.use().get(at?.id ?? "");
  if (why === "ended-for-safety") return <ErrorAction onClick={() => (window.location.hash = "#")}>Start a new one</ErrorAction>;
  const choose = why === "model-unavailable" && <ErrorAction onClick={() => askModel.dispatchEvent(new Event("ask"))}>Choose another model</ErrorAction>;
  const message = session?.items.findLast((item) => item.kind === "message" && item.role === "user");
  if (!at || at.offline || session?.id !== at.id || message?.kind !== "message" || message.turnId !== turn || !session.rewind?.includes(turn) || (retrying && retrying.turn !== turn)) return choose;
  if (retrying && !retrying.error) return <>{choose}<span className="shimmer">Retrying…</span></>;
  const entry = retrying ?? { turn, text: message.text, draft: message.draft, op: newId(), asking: false };
  return (
    <>
      {choose}
      <ErrorAction disabled={retrying?.asking || retrying?.unknown} onClick={() => rewindRetry(daemonRun, at.id, entry)}>
        Retry
      </ErrorAction>
    </>
  );
}

/**
 * The rebirth loop guard's Continue [D144]: Rust starts the guard over and carries the task on in a fresh
 * conversation. Under way at once, gone once Rust's row no longer says stalled; a refusal says why, with Try again.
 */
export function GoOn({ turn }: { turn: string }) {
  const at = useContext(SessionOfThread);
  // Rust's row names the last turn, by id, while the loop guard holds it.
  const row = useDaemon().rows?.find((r) => r.id === at?.id) as (Row & { stalled?: string | null }) | undefined;
  const [state, setState] = useState<{ asking: boolean; error?: string }>({ asking: false });
  if (!at || row?.stalled !== turn) return null;
  if (state.asking) return <span className="shimmer">Continuing…</span>;
  const go = () => {
    setState({ asking: true });
    void daemonRun(["rebirth", at.id, "--go-on"]).then((back) => setState(back.ok ? { asking: true } : { asking: false, error: failure(back) }));
  };
  return (
    <>
      {state.error && <span className="me-1.5">· Couldn’t continue: {state.error}</span>}
      <ErrorAction disabled={at.offline} onClick={go}>
        {state.error ? "Try again" : "Continue"}
      </ErrorAction>
    </>
  );
}

/** "A retires on 12 Dec." with what it suggests, never a move it hasn't said it makes [D74]. */
export function retiringNotice({ name, at, to }: Retiring): Notice {
  const when = at === null ? `${name} is being retired.` : at > Date.now() ? `${name} retires on ${new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}.` : `${name} was retired.`;
  return {
    id: "retiring",
    level: "info",
    text: to ? `${when} ${to} is suggested instead.` : `${when} Pick another model to keep going.`,
    action: (
      <Button variant="link-blue" size="xs" className="-my-0.5" onClick={() => askModel.dispatchEvent(new Event("ask"))}>
        Choose another model
      </Button>
    ),
  };
}

// shortcut: pending retries survive navigation and reconnects; use durable commands when renderer-restart recovery is added.
type Retrying = { turn: string; text: string; draft?: Draft | null; op: string; asking: boolean; unknown?: boolean; error?: string };
const retries = store<ReadonlyMap<string, Retrying>>(new Map());
function keepRetry(id: string, entry: Retrying | null) {
  const next = new Map(retries.get());
  if (entry) next.set(id, entry);
  else next.delete(id);
  retries.set(next);
}
function rewindRetry(run: Runner, id: string, entry: Retrying) {
  if (retries.get().get(id)?.asking) return;
  keepRetry(id, { ...entry, asking: true, unknown: false, error: undefined });
  void run(["rewind", id, entry.turn, "--op", entry.op]).then(async (back) => {
    if (retries.get().get(id)?.op !== entry.op) return;
    if (!back.ok) {
      keepRetry(id, { ...entry, asking: false, unknown: back.error === "disconnected", error: String(back.message ?? back.error ?? "Refused") });
      return;
    }
    await retryMessage(run, id, entry.text, entry.turn, entry.draft);
    keepRetry(id, null);
  }, () => keepRetry(id, { ...entry, asking: false, unknown: true }));
}

const STEP: Record<SetupStep["kind"], string> = { worktree: "the worktree", setupScript: "the setup script", cli: "the agent's install" };

/**
 * The session's notices on the composer's rail (D64, D487), from what Rust and the daemon already report: the
 * thread that couldn't load (with Retry), the app's own connection, a setup that didn't finish. ✕ hides one for
 * this view only.
 */
export function SessionNotices({ id, offline, source, run }: { id: string; offline: boolean; source: Source; run: Runner }) {
  const thread = useThread();
  const session = useSyncExternalStore(source.subscribe, source.get);
  const [gone, setGone] = useState<ReadonlySet<Key>>(new Set());
  const retiring = useRetiring(id);
  const notices: Notice[] = retiring ? [retiringNotice(retiring)] : [];
  // A retry under way (FailedActions) and its refusal; one left unconfirmed by a dropped link goes on once it's back.
  const retrying = retries.use().get(id);
  useEffect(() => {
    const entry = retries.get().get(id);
    if (!offline && entry?.unknown && !entry.asking) rewindRetry(run, id, entry);
  }, [id, offline, run]);
  if (retrying) notices.push({
    id: retrying.op,
    level: retrying.unknown ? "info" : retrying.error ? "error" : "info",
    text: retrying.unknown ? "Rewind not confirmed yet. It’s checked once Brigadier reconnects." : retrying.error ? `Couldn’t retry: ${retrying.error}` : "Retrying this turn…",
    action: retrying.error && !retrying.unknown && <Button variant="link-blue" size="xs" className="-my-0.5" onClick={() => { putBack(id, retrying.text, true, retrying.draft); keepRetry(id, null); }}>Put back message</Button>,
  });
  const failed = session?.id === id ? session.setup?.steps.find((step) => step.state === "failed") : undefined;
  if (failed) notices.push({ id: "setup", level: "warning", text: `Setup didn’t finish: ${STEP[failed.kind]} failed. Its step above says why.` });
  if (thread?.id === id && thread.status === "error") {
    const retry = (
      <Button variant="link-blue" size="xs" className="-my-0.5" onClick={() => openThread(id)}>
        Retry
      </Button>
    );
    notices.push({ id: "load", level: "warning", text: "Couldn’t load messages", action: retry });
  }
  // A start from Home, as a card on the rail too (D487); "not confirmed" only while it truly isn't known [D300].
  const start = useStart(id);
  if (start?.unknown) notices.push({ id: "start", level: "info", text: "Not confirmed yet, so don’t send it again. It’s checked once Brigadier reconnects." });
  else if (start?.error && !start.asking) {
    const again = (
      <Button variant="link-blue" size="xs" className="-my-0.5" onClick={() => retry(id)}>
        Try again
      </Button>
    );
    notices.push({ id: "start", level: "error", text: `Couldn’t start this conversation. ${start.error}`, action: again });
  }
  // A git action that failed here, said here and not in a toast [D1264].
  const git = useGitNotice(id);
  if (git.notice) notices.push(git.notice);
  if (offline) notices.push({ id: "offline", level: "info", text: "Reconnecting to Brigadier…" });
  return (
    <>
      <Notices notices={notices.filter((notice) => !gone.has(notice.id))} onDismiss={(key) => git.dismiss(key) || setGone(new Set(gone).add(key))} />
      {git.dialog}
    </>
  );
}
