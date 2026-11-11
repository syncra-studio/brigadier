import { type Key, type ReactElement, useEffect, useState } from "react";

import { Button } from "../components/button";
import type { Notice } from "../components/composer/rail";
import { Dialog, DialogContent, DialogTitle } from "../components/dialog";
import { showToast } from "../components/toast";
import { ask, useDaemon } from "../daemon";
import { store } from "../onboarding/api";
import { refreshStep, sourceArgs, type Target } from "./git";
import { MessageDialog } from "./source/action-confirms";

/**
 * A git action's failure in a session, as a notice above its composer instead of a red toast [D1142, D1264, D1266]:
 * one plain sentence, git's or the host's own output behind Details. `writer`: the message writer failed, so nothing
 * was committed and "Type a message…" is offered [D1029, D1293]. A project's folder has no session composer: a toast.
 */
type GitNotice = { id: number; text: string; details: string; writer: boolean };

const notices = store<ReadonlyMap<string, GitNotice>>(new Map());
let last = 0;
/** A scratch file's path in git's words says nothing to the user [D1264]. */
const TEMP = /(?:\/private)?\/(?:var\/folders|tmp)\/\S+/g;

export function gitFailed(target: Target | null, said: string, details = "", writer = false): void {
  said = said.replace(TEMP, "…").trim();
  details = details.replace(TEMP, "…").trim();
  if (!target || !("session" in target)) return void showToast(said, {
    tone: "error",
    actions: details ? [{ label: "Details", run: () => showToast(details, { tone: "error", stays: true }) }] : [],
  });
  notices.set(new Map(notices.get()).set(target.session, { id: ++last, text: said, details, writer }));
}

function drop(session: string): void {
  const next = new Map(notices.get());
  next.delete(session);
  notices.set(next);
}

/** Archived sessions have no composer, so their git errors use the folder's toast fallback. */
export function useArchivedGitNotice(session: string): void {
  const archived = useDaemon().rows?.find((row) => row.id === session)?.archived;
  const now = notices.use().get(session);
  useEffect(() => {
    if (!archived || !now) return;
    gitFailed(null, now.text, now.details);
    drop(session);
  }, [session, archived, now]);
}

/**
 * The session's git notice for its composer's rail, Details opening git's own words, with "Type a
 * message…" after a writer failure; its small dialog commits with the typed message [D1293]. `dismiss` takes ✕ for
 * it and says whether the key was its own.
 */
export function useGitNotice(session: string): { notice: Notice | null; dialog: ReactElement; dismiss: (key: Key) => boolean } {
  const now = notices.use().get(session);
  const [open, setOpen] = useState<number | null>(null);
  const [typing, setTyping] = useState<string | null>(null);
  const key = now && `git-${now.id}`;
  const notice: Notice | null = now
    ? {
        id: key!,
        level: "error",
        text: now.text,
        action: (
          <>
            {now.details && (
              <Button variant="link-blue" size="xs" className="-my-0.5" onClick={() => setOpen(now.id)}>
                Details
              </Button>
            )}
            {now.writer && (
              <Button variant="link-blue" size="xs" className="-my-0.5" onClick={() => setTyping("")}>
                Type a message…
              </Button>
            )}
          </>
        ),
      }
    : null;
  const dialog = (
    <>
      <Dialog open={!!now && open === now.id} onOpenChange={(next) => !next && setOpen(null)}>
        <DialogContent>
          <DialogTitle>Git details</DialogTitle>
          <pre className="max-h-80 overflow-auto font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">{now?.details}</pre>
        </DialogContent>
      </Dialog>
      <MessageDialog
        open={typing !== null}
        message={typing ?? ""}
        failed
        onMessage={setTyping}
        onCancel={() => setTyping(null)}
        onSave={() => {
          const message = (typing ?? "").trim();
          if (!message) return;
          setTyping(null);
          drop(session);
          ask({ op: "run", args: sourceArgs({ session }, "make-commit", "--all", "--message", message) }, (reply) => {
            if (!reply.ok) gitFailed({ session }, "Couldn't commit.", reply.error === "disconnected" ? "Brigadier isn't connected." : String(reply.error));
            ask({ op: "git_refresh" });
            refreshStep();
          });
        }}
      />
    </>
  );
  return { notice, dialog, dismiss: (k) => (k === key ? (drop(session), true) : false) };
}
