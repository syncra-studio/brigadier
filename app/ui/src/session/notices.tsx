import { type Key, useState, useSyncExternalStore } from "react";

import { Button } from "../components/button";
import { type Notice, Notices } from "../components/composer/rail";
import { openThread, useThread } from "../daemon";
import type { RailNotice, SetupStep } from "../thread/item";
import { askModel, type Retiring, useRetiring } from "./model";
import type { Source } from "../thread/thread";

/** Rust's notice in words: what happened, then the CLI's own words; and what to do about it. */
function said(notice: RailNotice): Notice {
  const tail = notice.text ? ` ${notice.text}` : "";
  switch (notice.reason) {
    case "turn-failed":
      // shortcut: no Retry yet; it rewinds to the turn's message and resends it once rewind is on main (D492).
      return notice.cause === "capacity"
        ? { id: notice.id, level: "warning", text: `The model’s servers are busy, so this turn didn’t finish. Send it again in a moment.${tail}` }
        : { id: notice.id, level: "error", text: `This turn didn’t finish.${tail}` };
    case "model-unavailable":
      return {
        id: notice.id,
        level: "warning",
        text: `This model isn’t available.${tail}`,
        action: (
          <Button variant="link-blue" size="xs" className="-my-0.5" onClick={() => askModel.dispatchEvent(new Event("ask"))}>
            Choose another model
          </Button>
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

const STEP: Record<SetupStep["kind"], string> = { worktree: "the worktree", setupScript: "the setup script", cli: "the agent's install" };

/**
 * The session's notices on the composer's rail (D64, D487), from what Rust and the daemon already report: the
 * thread that couldn't load (with Retry), the app's own connection, a setup that didn't finish. ✕ hides one for
 * this view only.
 */
export function SessionNotices({ id, offline, source }: { id: string; offline: boolean; source: Source }) {
  const thread = useThread();
  const session = useSyncExternalStore(source.subscribe, source.get);
  const [gone, setGone] = useState<ReadonlySet<Key>>(new Set());
  const retiring = useRetiring(id);
  const notices: Notice[] = retiring ? [retiringNotice(retiring)] : [];
  if (session?.id === id) notices.push(...(session.notices ?? []).map(said));
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
  if (offline) notices.push({ id: "offline", level: "info", text: "Reconnecting to Brigadier…" });
  return <Notices notices={notices.filter((notice) => !gone.has(notice.id))} onDismiss={(key) => setGone(new Set(gone).add(key))} />;
}
