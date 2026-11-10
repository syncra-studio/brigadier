import { useEffect, useState } from "react";

import { ask, useDaemon } from "../daemon";

/**
 * Who else works in a session's folder, as Rust reads it (`source <id> share`) [D1070, D1082], by session id: `with`
 * the session that lands its work where that's another, `busy` one working there now, `includes` one whose changes
 * are uncommitted here. Read when Source shows, again as any session starts or ends a turn, is archived, restored,
 * made or deleted (their rows), when the folder changes (`version`), and on reconnect [D30, D1143]. Null until the
 * first read: nothing is said of sharing yet. A read that fails or a lost link keeps the last read; Rust's own
 * refusals still guard each action.
 */
export type Share = { shared: boolean; with: string | null; busy: string | null; lands: boolean; includes: string | null };

export function useShare(session: string | null, version: number): Share | null {
  const { daemon, rows } = useDaemon();
  const [share, setShare] = useState<{ of: string; share: Share } | null>(null);
  // Whatever a row says that could change who shares the folder or works in it.
  const sessions = rows?.map((row) => `${row.id}:${row.state}:${row.works}:${row.archived}:${row.lifecycle?.op}`).join() ?? "";
  useEffect(() => {
    if (!session || !daemon) return;
    let live = true;
    ask({ op: "run", args: ["source", session, "share"] }, (reply) => {
      if (live && reply.ok) setShare({ of: session, share: reply as unknown as Share });
    });
    return () => {
      live = false;
    };
  }, [session, daemon?.pid, sessions, version]);
  return share?.of === session ? share.share : null;
}
