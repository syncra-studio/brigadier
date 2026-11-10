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
// No `preview` yet: clicked before Rust's answer came, so the dialog waits for it.
type Asking = { cid: string; op: string; text: string; preview?: RewindPreview; error?: string };
/** Rust's answer per message, and when it was asked for. */
type Looked = { at: number; preview?: RewindPreview };
/** The dialog's card: 28rem, the old app's max-w-md dialog, so no line wraps [D480, D483]; the theme's 28rem token. */
export const FRAME = "max-w-card-narrow gap-4 p-5";
/** How long an answer stands before the pointer coming back asks again. */
const FRESH_MS = 2_000;
type Running = { cid: string; n: number | undefined; replied: boolean };

const why = (reply: Record<string, any>) => (reply.error === "disconnected" ? "Brigadier isn't running, so the outcome isn't known yet." : String(reply.message ?? reply.error ?? "Refused"));

function previewOf(reply: Record<string, any>): RewindPreview {
  const none = { paths: [], hand: [], leftOut: [], commits: false };
  if (!reply.ok) return { ...none, error: why(reply) };
  return reply.restore === true ? { paths: reply.paths ?? [], hand: reply.hand ?? [], leftOut: reply.leftOut ?? [], commits: reply.commits === true } : none;
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
  // Answers stand until a turn starts or ends, or the messages that can be rewound to change.
  const points = session?.rewind?.join(" ");
  const looked = useMemo(() => new Map<string, Looked>(), [id, row?.running, points]);
  // Settled by id: the reply is in and Rust's thread no longer has the message.
  useEffect(() => {
    if (running?.replied && !session?.items.some((item) => "cid" in item && item.cid === running.cid)) setRunning(null);
  }, [running, session]);
  const value = useMemo(() => {
    const queued = (row?.queue?.items.length ?? 0) > 0 || !!row?.queue?.editing;
    const blocked = offline ? "Reconnecting…" : running ? "Rewinding…" : row?.running ? "Stop the turn first" : queued ? "Send or remove the queued messages first" : undefined;
    // Rust looks at the folder as the pointer or focus reaches the message, so by the click the dialog
    // opens whole, in one frame [D446, D480].
    const look = (cid: string) => {
      const had = looked.get(cid);
      if (had && Date.now() - had.at < FRESH_MS) return;
      const now: Looked = { at: Date.now() };
      looked.set(cid, now);
      void run(["rewind", id, cid, "--preview"]).then((reply) => {
        now.preview = previewOf(reply);
        setAsking((asking) => (asking?.cid === cid && !asking.preview ? { ...asking, preview: now.preview } : asking));
      });
    };
    const open = (cid: string, text: string) => {
      if (!looked.has(cid)) look(cid);
      setAsking({ cid, op: newId(), text, preview: looked.get(cid)?.preview });
    };
    const first = running && session?.items.find((item) => "cid" in item && item.cid === running.cid);
    const turnsGone = new Set(running ? session?.turns.slice(session.turns.findIndex((turn) => turn.id === running.cid)).map((turn) => turn.id) : []);
    return {
      offer: (cid: string, text: string) => (session?.rewind?.includes(cid) ? { blocked, open: () => open(cid, text), look: () => look(cid) } : undefined),
      gone: (n: number | undefined, turn: string | undefined) => !!running && ((first && n !== undefined && first.n !== undefined && n >= first.n) || (turn !== undefined && turnsGone.has(turn))),
    };
  }, [session, running, offline, row?.running, row?.queue, id, run, looked]);
  const go = (restore: boolean) => {
    if (!asking?.preview) return;
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
      <Dialog open={!!asking?.preview} onOpenChange={(next) => !next && setAsking(null)}>
        <DialogContent frame={FRAME}>{asking?.preview && <RewindForm preview={asking.preview} error={asking.error} onKeep={() => go(false)} onRestore={() => go(true)} onCancel={() => setAsking(null)} />}</DialogContent>
      </Dialog>
    </RewindContext.Provider>
  );
}
