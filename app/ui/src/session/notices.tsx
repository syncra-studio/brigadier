import { type Key, useState, useSyncExternalStore } from "react";

import { Button } from "../components/button";
import { type Notice, Notices } from "../components/composer/rail";
import { openThread, useThread } from "../daemon";
import type { SetupStep } from "../thread/item";
import type { Source } from "../thread/thread";

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
  const notices: Notice[] = [];
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
