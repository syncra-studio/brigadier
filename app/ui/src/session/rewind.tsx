import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { Dialog, DialogContent } from "../components/dialog";
import { RewindContext, RewindForm, type RewindPreview } from "../components/thread/rewind";
import { showToast } from "../components/toast";
import { threadSource } from "../daemon";
import type { Source } from "../thread/thread";
import { type ComposerRow, daemonRun, type Runner } from "./composer";
import { putBack } from "./side";
import { newId } from "./store";

type Asking = { cid: string; text: string; preview: RewindPreview; error?: string };
type Running = { cid: string; n: number | undefined; replied: boolean };

const why = (reply: Record<string, any>) => (reply.error === "disconnected" ? "Brigadier isn't running, so the outcome isn't known yet." : String(reply.message ?? reply.error ?? "Refused"));

function said(reply: Record<string, any>, restore: boolean): string {
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
    const open = (cid: string, text: string) => {
      setAsking({ cid, text, preview: { status: "loading" } });
      void run(["rewind", id, cid, "--preview"]).then((reply) => {
        const preview: RewindPreview = reply.ok ? { status: "ready", restore: reply.restore === true, why: reply.why, paths: reply.paths ?? [], hand: reply.hand ?? [], leftOut: reply.leftOut ?? [], commits: reply.commits === true } : { status: "error", error: why(reply) };
        setAsking((now) => (now?.cid === cid ? { ...now, preview } : now));
      });
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
    const { cid, text, preview } = asking;
    const n = session?.items.find((item) => "cid" in item && item.cid === cid)?.n;
    setAsking(null);
    setRunning({ cid, n, replied: false });
    void run(["rewind", id, cid, "--op", newId(), ...(restore ? ["--restore"] : [])]).then((reply) => {
      if (!reply.ok) {
        setRunning(null);
        setAsking({ cid, text, preview, error: why(reply) });
        return;
      }
      setRunning((now) => now && { ...now, replied: true });
      putBack(id, text, true);
      showToast(said(reply, restore), { tone: restore && reply.complete === false ? "neutral" : "success" });
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
