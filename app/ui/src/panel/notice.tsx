import { type Key, type ReactElement, useState } from "react";

import { Button } from "../components/button";
import type { Notice } from "../components/composer/rail";
import { showToast } from "../components/toast";
import { store } from "../onboarding/api";
import { commitFiles, refreshStep, type Target } from "./git";
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
  details = details.replace(TEMP, "…").trim();
  if (!target || !("session" in target)) return void showToast(details ? `${said}\n\n${details}` : said, { tone: "error" });
  notices.set(new Map(notices.get()).set(target.session, { id: ++last, text: said, details, writer }));
}

function drop(session: string): void {
  const next = new Map(notices.get());
  next.delete(session);
  notices.set(next);
}

/**
 * The session's git notice for its composer's rail, Details opening git's own words under the sentence, with "Type a
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
        text: open === now.id && now.details ? `${now.text}\n\n${now.details}` : now.text,
        action: (
          <>
            {now.details && open !== now.id && (
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
        const sent = commitFiles(true, message, (reply) => {
          if (!reply.ok) gitFailed({ session }, "Couldn't commit.", reply.error === "disconnected" ? "Brigadier isn't connected." : String(reply.error));
          refreshStep(true);
        });
        if (!sent) gitFailed({ session }, "Couldn't commit.", "This checkout isn't on screen.");
      }}
    />
  );
  return { notice, dialog, dismiss: (k) => (k === key ? (drop(session), true) : false) };
}
