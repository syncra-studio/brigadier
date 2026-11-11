import { useRef, useState } from "react";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { ArrowUpRight, X } from "../icons";
import { errorText, run, store } from "../onboarding/api";

/*
 * Send feedback, the old app's dialog [D353]. Send has Rust fill a new issue on Brigadier's repository with the note
 * and the versions, and opens it in the browser for the user to post; Brigadier sends nothing itself [D2017, D2022].
 * Its GitHub sign-in and filing screens went with that [D2092].
 */

const ASK = "What’s wrong, or what would you like? Several things at once is fine.";
/** The blank new-issue page, where the user writes it all themselves. */
const NEW_ISSUE = "https://github.com/syncra-studio/brigadier/issues/new";

type Sending = { phase: "write" } | { phase: "opening" } | { phase: "opened" } | { phase: "failed"; error: string };

const state = store<{ open: boolean }>({ open: false });

export const openFeedback = () => state.set({ open: true });

export function FeedbackDialog() {
  const { open } = state.use();
  const close = () => state.set({ open: false });
  const focus = useRef<HTMLElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent showCloseButton={false} frame="max-w-feedback gap-0 p-0" initialFocus={focus}>
        <Feedback focusRef={(element) => void (focus.current = element)} />
      </DialogContent>
    </Dialog>
  );
}

function Feedback({ focusRef }: { focusRef: (element: HTMLElement | null) => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState<Sending>({ phase: "write" });
  const opening = sending.phase === "opening";
  const done = sending.phase === "opened";
  const send = () => {
    setSending({ phase: "opening" });
    run(["feedback", text]).then(
      (reply) => {
        window.brigadier?.openLink(reply.url);
        setSending({ phase: "opened" });
      },
      (cause) => setSending({ phase: "failed", error: errorText(cause) }),
    );
  };
  return (
    <>
      <div className="flex gap-3.5 ps-6 pe-5 pt-6 pb-4.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <DialogTitle>{done ? "Ready to post" : "Send feedback"}</DialogTitle>
          <DialogDescription>{done ? "Opened in your browser. Post it there." : "Say what’s wrong or what you’d like."}</DialogDescription>
        </div>
        <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="Close" />}>
          <X />
        </DialogClose>
      </div>
      {!done && (
        <div className="flex flex-col gap-3 px-6 pb-5.5">
          <textarea
            ref={focusRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            readOnly={opening}
            spellCheck
            placeholder={ASK}
            aria-label={ASK}
            className={cx(
              "h-37 resize-none rounded-control border border-transparent bg-feedback-field px-3.5 py-3 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:bg-background focus-visible:focus-ring",
              opening && "text-feedback-working",
            )}
          />
          <p className="min-h-4 text-xs text-muted-foreground">Opens on GitHub in your browser, with your app and macOS version.</p>
          <ErrorLine error={sending.phase === "failed" ? `${sending.error} Your note is still here.` : null} />
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-divider ps-3.5 pe-6 py-4">
        {!done && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => window.brigadier?.openLink(NEW_ISSUE)}>
            Write it on GitHub yourself
            <ArrowUpRight className="size-icon-sm" />
          </Button>
        )}
        <span className="flex-1" />
        {done ? (
          <DialogClose render={<Button size="sm" ref={focusRef} />}>Done</DialogClose>
        ) : (
          <Button size="sm" disabled={opening || !text.trim()} onClick={send}>
            {opening ? "Sending…" : sending.phase === "failed" ? "Try again" : "Send"}
          </Button>
        )}
      </div>
    </>
  );
}
