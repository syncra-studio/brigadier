import { type Key, type ReactNode, useEffect, useState, useSyncExternalStore } from "react";

import { Button } from "../components/button";
import { type Notice, Notices } from "../components/composer/rail";
import { openThread, useThread } from "../daemon";
import type { RailNotice, SetupStep } from "../thread/item";
import { retry, useStart } from "../home/start";
import { store } from "../onboarding/api";
import { askModel, type Retiring, useRetiring } from "./model";
import type { Source } from "../thread/thread";
import { retryMessage, type Runner } from "./composer";
import { newId } from "./store";
import { putBack } from "./side";

/** Rust's notice in words: what happened, then the CLI's own words; and what to do about it. `again` resends its turn. */
export function sessionNotice(notice: RailNotice, again: ReactNode): Notice {
  const tail = notice.text ? ` ${notice.text}` : "";
  switch (notice.reason) {
    case "turn-failed":
      return notice.cause === "capacity"
        ? { id: notice.id, level: "warning", text: `The model’s servers are busy, so this turn didn’t finish.${tail}`, action: again }
        : { id: notice.id, level: "error", text: `This turn didn’t finish.${tail}`, action: again };
    case "model-unavailable":
      return {
        id: notice.id,
        level: "warning",
        text: `This model isn’t available.${tail}`,
        action: (
          <>
            <Button variant="link-blue" size="xs" className="-my-0.5" onClick={() => askModel.dispatchEvent(new Event("ask"))}>
              Choose another model
            </Button>
            {again}
          </>
        ),
      };
    case "ended-for-safety":
      return {
        id: notice.id,
        level: "warning",
        text: `A safety check ended this conversation, so it can’t go on.${tail}`,
        action: (
          <Button variant="link-blue" size="xs" className="-my-0.5" onClick={() => (window.location.hash = "#")}>
            Start a new one
          </Button>
        ),
      };
  }
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
type Retrying = { turn: string; text: string; op: string; asking: boolean; unknown?: boolean; error?: string };
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
    await retryMessage(run, id, entry.text, entry.turn);
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
  // Retry: back to the failed turn's message, files kept, and it again in that attempt's place (D492). Only where
  // Rust offers a rewind to it; shown at once as under way, its refusal said in the notice's place [D30].
  const retrying = retries.use().get(id);
  useEffect(() => {
    const entry = retries.get().get(id);
    if (!offline && entry?.unknown && !entry.asking) rewindRetry(run, id, entry);
  }, [id, offline, run]);
  const again = (turn: string) => {
    const message = session?.items.find((item) => item.kind === "message" && item.role === "user" && item.turnId === turn);
    if (offline || !message || message.kind !== "message" || !session?.rewind?.includes(turn)) return null;
    if (retrying && retrying.turn !== turn) return null;
    if (retrying && !retrying.error) return <span className="text-xs text-muted-foreground shimmer">Retrying…</span>;
    return (
      <Button variant="link-blue" size="xs" className="-my-0.5" disabled={retrying?.asking || retrying?.unknown} onClick={() => rewindRetry(run, id, retrying ?? { turn, text: message.text, op: newId(), asking: false })}>
        Retry
      </Button>
    );
  };
  if (session?.id === id) notices.push(...(session.notices ?? []).map((notice) => sessionNotice(notice, again(notice.turnId))));
  if (retrying) notices.push({
    id: retrying.op,
    level: retrying.unknown ? "info" : retrying.error ? "error" : "info",
    text: retrying.unknown ? "Rewind not confirmed yet. It’s checked once Brigadier reconnects." : retrying.error ? `Couldn’t retry: ${retrying.error}` : "Retrying this turn…",
    action: retrying.error && !retrying.unknown && <Button variant="link-blue" size="xs" className="-my-0.5" onClick={() => { putBack(id, retrying.text, true); keepRetry(id, null); }}>Put back message</Button>,
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
  if (offline) notices.push({ id: "offline", level: "info", text: "Reconnecting to Brigadier…" });
  return <Notices notices={notices.filter((notice) => !gone.has(notice.id))} onDismiss={(key) => setGone(new Set(gone).add(key))} />;
}
