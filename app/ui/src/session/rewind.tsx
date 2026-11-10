import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { Dialog, DialogContent } from "../components/dialog";
import { RewindContext, RewindForm, type RewindPreview } from "../components/thread/rewind";
import { showToast } from "../components/toast";
import { threadSource } from "../daemon";
import type { Source } from "../thread/thread";
import { type ComposerRow, daemonRun, type Runner } from "./composer";
import { putBack } from "./side";
import { newId } from "./store";

// One id for all of a confirmation's tries: a reply lost after the rewind landed is answered as already done.
type Asking = { cid: string; op: string; text: string; preview: RewindPreview; error?: string };
type Running = { cid: string; n: number | undefined; replied: boolean };

const why = (reply: Record<string, any>) => (reply.error === "disconnected" ? "Brigadier isn't running, so the outcome isn't known yet." : String(reply.message ?? reply.error ?? "Refused"));

/** One of the two preview answers into what's known; either may come first. */
function merged(now: RewindPreview, reply: Record<string, any>, files: boolean): RewindPreview {
  if (!reply.ok) return { ...now, error: why(reply) };
  if (reply.restore !== true) return { ...now, restore: false, why: now.why ?? reply.why };
  if (!files) return { ...now, restore: now.restore ?? true };
  return { ...now, files: { paths: reply.paths ?? [], hand: reply.hand ?? [], leftOut: reply.leftOut ?? [], commits: reply.commits === true } };
}

function said(reply: Record<string, any>, restore: boolean): string {
  if (reply.already) return "Rewound · check your files";
  if (!restore) return "Rewound · your files are as they were";
  const count = `${reply.restored} ${reply.restored === 1 ? "file" : "files"} restored`;
  return reply.complete === false ? `Rewound · ${count}, some stayed as they are` : `Rewound · ${count}`;
}

/** The session's rewind [D384]: what its messages offer, the confirmation, and the rows dimmed until Rust's thread comes back. */
export function RewindProvider({ id, row, offline, children, run = daemonRun, source = threadSource }: { id: string; row: ComposerRow | undefined; offline: boolean; children: ReactNode; run?: Runner; source?: Source }) {
  const session = useSyncExternalStore(source.subscribe, source.get);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [running, setRunning] = useState<Running | null>(null);
  // Settled by id: the reply is in and Rust's thread no longer has the message.
  useEffect(() => {
    if (running?.replied && !session?.items.some((item) => "cid" in item && item.cid === running.cid)) setRunning(null);
  }, [running, session]);
  const value = useMemo(() => {
    const queued = (row?.queue?.items.length ?? 0) > 0 || !!row?.queue?.editing;
    const blocked = offline ? "Reconnecting…" : running ? "Rewinding…" : row?.running ? "Stop the turn first" : queued ? "Send or remove the queued messages first" : undefined;
    // Opens at once: whether files can go back comes in a millisecond, inside the dialog's opening; what
    // they are takes a look at the folder, and fills in when it's done [D446].
    const open = (cid: string, text: string) => {
      const op = newId();
      setAsking({ cid, op, text, preview: {} });
      const answered = (files: boolean) => (reply: Record<string, any>) =>
        setAsking((now) => (now?.op === op ? { ...now, preview: merged(now.preview, reply, files) } : now));
      void run(["rewind", id, cid, "--preview"]).then(answered(false));
      void run(["rewind", id, cid, "--preview", "--files"]).then(answered(true));
    };
    const first = running && session?.items.find((item) => "cid" in item && item.cid === running.cid);
    const turnsGone = new Set(running ? session?.turns.slice(session.turns.findIndex((turn) => turn.id === running.cid)).map((turn) => turn.id) : []);
    return {
      offer: (cid: string, text: string) => (session?.rewind?.includes(cid) ? { blocked, open: () => open(cid, text) } : undefined),
      gone: (n: number | undefined, turn: string | undefined) => !!running && ((first && n !== undefined && first.n !== undefined && n >= first.n) || (turn !== undefined && turnsGone.has(turn))),
    };
  }, [session, running, offline, row?.running, row?.queue, id, run]);
  const go = (restore: boolean) => {
    if (!asking) return;
    const { cid, op, text, preview } = asking;
    const n = session?.items.find((item) => "cid" in item && item.cid === cid)?.n;
    setAsking(null);
    setRunning({ cid, n, replied: false });
    void run(["rewind", id, cid, "--op", op, ...(restore ? ["--restore"] : [])]).then((reply) => {
      if (!reply.ok) {
        setRunning(null);
        setAsking({ cid, op, text, preview, error: why(reply) });
        return;
      }
      setRunning((now) => now && { ...now, replied: true });
      putBack(id, text, true);
      showToast(said(reply, restore), { tone: reply.already || (restore && reply.complete === false) ? "neutral" : "success" });
    });
  };
  return (
    <RewindContext.Provider value={value}>
      {children}
      <Dialog open={asking !== null} onOpenChange={(next) => !next && setAsking(null)}>
        <DialogContent>{asking && <RewindForm preview={asking.preview} error={asking.error} onKeep={() => go(false)} onRestore={() => go(true)} onCancel={() => setAsking(null)} />}</DialogContent>
      </Dialog>
    </RewindContext.Provider>
  );
}
