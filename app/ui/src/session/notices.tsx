import { type Key, useContext, useEffect, useState, useSyncExternalStore } from "react";

import { Button } from "../components/button";
import type { Draft } from "../components/composer/draft";
import { type Notice, Notices } from "../components/composer/rail";
import { openThread, type Row, useDaemon, useThread } from "../daemon";
import type { Item, SetupStep, Turn } from "../thread/item";
import { Body } from "../components/thread/body";
import { WorkingLine } from "../components/thread/work";
import { SessionOfThread } from "../accounts/limit";
import { ErrorAction } from "../components/thread/error-state";
import { answeringSource } from "./decisions";
import { retry, useStart } from "../home/start";
import { store } from "../onboarding/api";
import { askModel, type Retiring, useRetiring } from "./model";
import type { Source } from "../thread/thread";
import { daemonRun, failure, type Runner } from "./composer";
import { sendMessage } from "./sent";
import { newId } from "./store";
import { putBack } from "./side";
import { useGitNotice } from "../panel/notice";

type Failed = Extract<Item, { reason: "failed" }>;

/**
 * A failed turn's row. While Rust waits for the network to come back to resume it, "Reconnecting…", as work under
 * way, never failed; then its error and Try again [D339].
 */
export function FailedNotice({ item, turn }: { item: Failed & { turnId: string }; turn: Turn | undefined }) {
  const at = useContext(SessionOfThread);
  const row = useDaemon().rows?.find((r) => r.id === at?.id);
  if (row?.reconnect?.turn === item.turnId && !item.resumed) return <WorkingLine state="live">Reconnecting…</WorkingLine>;
  return <Body item={item} turn={turn} step={false} again={<FailedActions turn={item.turnId} why={item.why} cause={item.cause} state={row?.state} />} />;
}

/** A passing failure's Try again: the turn carries on in the same conversation, shown at once as reconnecting [D339, D30]. */
function TryAgain({ id }: { id: string }) {
  const [state, setState] = useState<{ asking: boolean; error?: string }>({ asking: false });
  if (state.asking) return <span className="shimmer">Reconnecting…</span>;
  const go = () => {
    setState({ asking: true });
    void daemonRun(["reconnect", id, "--now"]).then((back) => setState(back.ok ? { asking: true } : { asking: false, error: failure(back) }));
  };
  return (
    <>
      {state.error && <span>· Couldn’t try again: {state.error}</span>}
      <ErrorAction onClick={go}>Try again</ErrorAction>
    </>
  );
}

/**
 * A failed turn's actions on its row [D54]: what its reason offers, and Retry while it is the last turn and Rust
 * offers a rewind to it: back to its message, files kept, and it again in that attempt's place (D492). Shown at once
 * as under way; a refusal is said on the rail [D30].
 */
export function FailedActions({ turn, why, cause, state }: { turn: string; why: Failed["why"]; cause: Failed["cause"]; state: string | undefined }) {
  const at = useContext(SessionOfThread);
  const session = useSyncExternalStore(answeringSource.subscribe, answeringSource.get);
  const retrying = retries.use().get(at?.id ?? "");
  if (why === "ended-for-safety") return <ErrorAction onClick={() => (window.location.hash = "#")}>Start a new one</ErrorAction>;
  // The last turn a passing failure ended carries on where it was cut, its work kept, never rewound [D339].
  const last = session?.items.findLast((item) => item.kind === "notice" && "why" in item);
  if (cause && at && !at.offline && state === "failed" && last?.turnId === turn) return <TryAgain key={turn} id={at.id} />;
  const choose = why === "model-unavailable" && <ErrorAction onClick={() => askModel.dispatchEvent(new Event("ask"))}>Choose another model</ErrorAction>;
  const message = session?.items.findLast((item) => item.kind === "message" && item.role === "user");
  // An agent that never started left nothing to rewind: its message just goes again [D476].
  const fresh = why === "start-failed" && at && !at.offline && message?.kind === "message" && message.turnId === turn;
  if (fresh) return <ErrorAction onClick={() => void sendMessage(daemonRun, at.id, message.text, turn, message.draft, message.origin)}>Try again</ErrorAction>;
  if (!at || at.offline || session?.id !== at.id || message?.kind !== "message" || message.turnId !== turn || !session.rewind?.includes(turn) || (retrying && retrying.turn !== turn)) return choose;
  if (retrying && !retrying.error) return <>{choose}<span className="shimmer">Retrying…</span></>;
  const entry = retrying ?? { turn, text: message.text, draft: message.draft, origin: message.origin, op: newId(), asking: false };
  return (
    <>
      {choose}
      <ErrorAction disabled={retrying?.asking || retrying?.unknown} onClick={() => rewindRetry(daemonRun, at.id, entry)}>
        Try again
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

/**
 * A library server's Sign in on the thread's line [wave4 D2043]: Rust starts it and answers the page, which opens in
 * the browser; "Waiting for browser…" with Cancel till Rust says how it ended. One sign-in fixes every session.
 */
export function PluginSignIn({ plugin }: { plugin: string }) {
  const at = useContext(SessionOfThread);
  const [state, setState] = useState<{ step: "idle" | "waiting" | "done"; error?: string; code?: string }>({ step: "idle" });
  if (state.step === "done") return <span className="text-muted-foreground">Signed in</span>;
  if (state.step === "waiting") {
    return (
      <>
        <span className="me-1.5 shimmer">Waiting for browser…</span>
        {state.code && <span className="me-1.5">Code {state.code}</span>}
        <ErrorAction onClick={() => void daemonRun(["plugins", "cancel", plugin])}>Cancel</ErrorAction>
      </>
    );
  }
  const go = async () => {
    setState({ step: "waiting" });
    const started = await daemonRun(["plugins", "signin", plugin]);
    if (!started.ok) return setState({ step: "idle", error: failure(started) });
    // A device sign-in's page asks for its code.
    if (typeof started.code === "string") setState({ step: "waiting", code: started.code });
    window.brigadier?.openLink(String(started.url));
    const ended = await daemonRun(["plugins", "wait", plugin]);
    setState(ended.ok ? { step: "done" } : { step: "idle", error: failure(ended) });
  };
  return (
    <>
      {state.error && <span className="me-1.5">· {state.error}</span>}
      <ErrorAction disabled={at?.offline} onClick={() => void go()}>
        {state.error ? "Try again" : "Sign in"}
      </ErrorAction>
    </>
  );
}

/** "A retires on 12 Dec." with what it suggests, never a move it hasn't said it makes [D74]. */
function retiringNotice({ name, at, to }: Retiring): Notice {
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
type Retrying = { turn: string; text: string; draft?: Draft | null; origin?: string; op: string; asking: boolean; unknown?: boolean; error?: string };
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
    await sendMessage(run, id, entry.text, entry.turn, entry.draft, entry.origin);
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
