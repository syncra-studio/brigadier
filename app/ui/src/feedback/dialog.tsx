import { useRef } from "react";

import { Button } from "../components/button";
import { CopyButton } from "../components/copy-button";
import { cx } from "../components/cx";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { ProgressLine } from "../components/progress-line";
import { ArrowUpRight, Bug, Lightbulb, Spinner, X } from "../icons";
import { type Account, closeFeedback, feedback, openSignIn, type Result, type Sending, type SignIn, sendFeedback, setText } from "./state";

export { openFeedback } from "./state";

/*
 * Send feedback, the old app's dialog and flow [D353, D2100] (state.ts sends it): the user only writes and sends.
 * Signed out, Send first shows the sign-in step under the note and files by itself once GitHub says yes; then it lists
 * what it filed, each with its link. "Write it on GitHub yourself" opens the blank new-issue page instead. The X
 * closes it; a send at work carries on and shows when it reopens.
 */

const ASK = "What’s wrong, or what would you like? Several things at once is fine.";
/** The blank new-issue page, where the user writes it all themselves [D2017]. */
const NEW_ISSUE = "https://github.com/syncra-studio/brigadier/issues/new";
const INSTALL_GH = "brew install gh";
export const FEEDBACK_FRAME = "max-w-feedback gap-0 p-0";

const openLink = (url: string) => window.brigadier?.openLink(url);

export function FeedbackDialog() {
  const { open, text, sending, account } = feedback.use();
  const focus = useRef<HTMLElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeFeedback()}>
      <DialogContent showCloseButton={false} frame={FEEDBACK_FRAME} initialFocus={focus}>
        <FeedbackView text={text} sending={sending} account={account} onText={setText} onSend={sendFeedback} onOpenSignIn={openSignIn} focusRef={(element) => void (focus.current = element)} />
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's insides for one moment of a send; the gallery shows each. */
export function FeedbackView({
  text,
  sending,
  account,
  onText,
  onSend,
  onOpenSignIn,
  focusRef,
}: {
  text: string;
  sending: Sending;
  account: Account | null;
  onText: (text: string) => void;
  onSend: () => void;
  onOpenSignIn: () => void;
  focusRef?: (element: HTMLElement | null) => void;
}) {
  const done = sending.phase === "done" ? sending.results : null;
  const unsent = done?.filter((result) => result.outcome === "failed").length ?? 0;
  const working = sending.phase === "working";
  const signingIn = sending.phase === "signIn" ? sending.signIn : null;
  // Signing in, Send waits for GitHub; without the GitHub CLI it is Try again, the note as after a failed send.
  const signInAtWork = signingIn !== null && signingIn.step !== "noGh";
  const waiting = working || signInAtWork;
  const browser = done?.every((result) => result.outcome === "opened") ?? false;
  const one = done?.length === 1;
  const line = !done
    ? "Say what’s wrong or what you’d like. Brigadier writes it up for its developers."
    : unsent
      ? `${unsent === 1 ? "One report" : `${unsent} reports`} couldn’t be sent.`
      : browser
        ? one
          ? "Opened in your browser. Post it there."
          : `${done.length} reports opened in your browser. Post each one there.`
        : one
          ? "Your report, filed on GitHub."
          : `${done.length} reports, filed on GitHub.`;
  const step = sending.phase === "working" ? sending.step : null;
  return (
    <>
      <div className="flex min-w-0 gap-3.5 ps-6 pe-5 pt-6 pb-4.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <DialogTitle>{!done ? "Send feedback" : unsent ? "Not all of it was sent" : browser ? "Ready to post" : "Thanks, it’s sent"}</DialogTitle>
          <DialogDescription>{line}</DialogDescription>
        </div>
        <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="Close" />}>
          <X />
        </DialogClose>
      </div>
      <div className="flex min-w-0 flex-col gap-3 px-6 pb-5.5">
        {done ? (
          <Results results={done} />
        ) : (
          <textarea
            ref={focusRef}
            value={text}
            onChange={(event) => onText(event.target.value)}
            readOnly={waiting}
            spellCheck
            placeholder={ASK}
            aria-label={ASK}
            className={cx(
              "h-37 resize-none rounded-control border border-transparent bg-feedback-field px-3.5 py-3 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:bg-background focus-visible:focus-ring",
              working && "text-feedback-working",
              signInAtWork && "text-muted-foreground",
            )}
          />
        )}
        {signingIn && <GitHubSignIn signIn={signingIn} onOpen={onOpenSignIn} />}
        {step && (
          <ProgressLine
            icon={false}
            title="Writing up your reports…"
            description={
              step.step === "writing"
                ? "Splitting your note and checking GitHub for ones already reported"
                : step.count === 1
                  ? "Filing it on GitHub"
                  : `Filing ${step.count} reports on GitHub`
            }
            done={step.step === "writing" ? 1 : 2}
            total={3}
            className="pt-1 text-muted-foreground"
          />
        )}
        {(sending.phase === "write" || sending.phase === "failed") && (
          <p className="min-h-4 text-xs text-muted-foreground">
            {account && (account.signedIn ? `Posts as ${account.login ? `@${account.login}` : "you"} on GitHub, with your app and macOS version.` : "Posts on GitHub once you sign in, with your app and macOS version.")}
          </p>
        )}
        <ErrorLine error={sending.phase === "failed" ? `${sending.error} Your note is still here.` : null} />
      </div>
      <div className="flex min-w-0 items-center gap-2 border-t border-divider ps-3.5 pe-6 py-4">
        {!done && !working && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => openLink(NEW_ISSUE)}>
            Write it on GitHub yourself
            <ArrowUpRight className="size-icon-sm" />
          </Button>
        )}
        <span className="flex-1" />
        {done && !unsent ? (
          <DialogClose render={<Button size="sm" ref={focusRef} />}>Done</DialogClose>
        ) : (
          <Button size="sm" disabled={waiting || !text.trim()} onClick={onSend}>
            {working ? "Sending…" : sending.phase === "failed" || unsent || signingIn?.step === "noGh" ? "Try again" : "Send"}
          </Button>
        )}
      </div>
    </>
  );
}

/** What was filed, one row per report in a soft box. A note only opened in the browser has no row. */
function Results({ results }: { results: readonly Result[] }) {
  const shown = results.filter((result) => result.outcome !== "opened");
  if (shown.length === 0) return null;
  return (
    <ul aria-label="Sent" className="flex flex-col rounded-settings bg-fill-subtle">
      {shown.map((result, index) => {
        const Icon = result.kind === "bug" ? Bug : Lightbulb;
        return (
          <li key={`${index}-${result.title}`} className={cx("flex min-w-0 items-center gap-2.5 px-3 py-2", index > 0 && "border-t border-divider")}>
            <Icon aria-hidden={false} aria-label={result.kind === "bug" ? "Bug" : "Idea"} className="size-icon-md shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-label">{result.title}</span>
            {result.outcome === "failed" ? (
              <span className="shrink-0 text-label text-destructive">Not sent</span>
            ) : (
              <Button variant="link" size="inline" className="text-sm" onClick={() => openLink(result.url)}>
                {result.outcome === "added" ? `Added to #${result.number}` : `#${result.number}`}
                <ArrowUpRight />
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Signing in to GitHub, under the note: a one-time code and Open GitHub, or the command that installs its CLI. */
function GitHubSignIn({ signIn, onOpen }: { signIn: SignIn; onOpen: () => void }) {
  const noGh = signIn.step === "noGh";
  const chip = noGh ? INSTALL_GH : signIn.step === "code" ? signIn.code : null;
  const waiting = signIn.step === "starting" || (signIn.step === "code" && signIn.opened);
  return (
    <div aria-label="Sign in to GitHub" className="flex flex-col gap-2.5">
      <p className="text-sm">{noGh ? "GitHub CLI isn’t installed. Install it, then try again." : "Sign in to GitHub so Brigadier can post your reports"}</p>
      {chip && (
        <div className="flex items-center gap-2">
          <span className="flex h-control-md items-center gap-1.5 rounded-control border border-fill-hover bg-fill-subtle ps-3 pe-1">
            <span className={noGh ? "font-mono text-sm" : "font-mono text-base font-medium tracking-widest"}>{chip}</span>
            <CopyButton text={chip} tooltip={noGh ? "Copy command" : "Copy code"} size="icon-xs" className="text-muted-foreground" />
          </span>
          {!noGh && (
            <Button variant="ghost" size="sm" onClick={onOpen}>
              Open GitHub
              <ArrowUpRight className="size-icon-sm text-muted-foreground" />
            </Button>
          )}
        </div>
      )}
      {waiting && (
        <p className="flex items-center gap-2 text-label text-muted-foreground">
          <Spinner className="size-icon-sm animate-spin motion-reduce:animate-none" />
          Waiting for GitHub…
        </p>
      )}
    </div>
  );
}
