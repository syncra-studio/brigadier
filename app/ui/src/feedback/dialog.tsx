import { useRef, useState } from "react";

import { Button } from "../components/button";
import { CopyButton } from "../components/copy-button";
import { cx } from "../components/cx";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { ProgressLine } from "../components/progress-line";
import { ArrowUpRight, Bug, Lightbulb, Spinner, X } from "../icons";
import { store } from "../onboarding/api";

/*
 * Send feedback, the old app's dialog as look and interaction only. Nothing is sent: Send, Try again and
 * Done just close it, and its links go nowhere. Each screen after the note shows fixed sample content.
 */

const ASK = "What’s wrong, or what would you like? Several things at once is fine.";
const NOTE = "The usage popover keeps the old numbers after a session ends. Stop on a worker doesn't stop it. I'd like to pin a chat to the top.";
const INSTALL_GH = "brew install gh";
const CODE = "WDJB-MJHT";

type Result = { kind: "bug" | "idea"; title: string; outcome: "filed" | "added" | "failed" | "opened"; number?: number };
type SignIn = { step: "starting" } | { step: "code"; opened: boolean } | { step: "noGh" };
type Sending = { phase: "write" } | { phase: "signIn"; signIn: SignIn } | { phase: "working"; step: "writing" | "filing" } | { phase: "done"; results: Result[] } | { phase: "failed"; error: string };

const USAGE = "Usage popover doesn't refresh when a session ends";
const STOP = "Stop doesn't stop a running worker";
const PIN = "Pin a chat to the top of the sidebar";

/** Every screen the dialog shows, with `login` who it posts as (null: signed out of GitHub). */
const SCREENS = {
  "write-signed-out": { sending: { phase: "write" }, login: null, text: "" },
  "write-signed-in": { sending: { phase: "write" }, login: "demo", text: "" },
  "signin-starting": { sending: { phase: "signIn", signIn: { step: "starting" } }, login: null, text: NOTE },
  "signin-code": { sending: { phase: "signIn", signIn: { step: "code", opened: false } }, login: null, text: NOTE },
  "signin-waiting": { sending: { phase: "signIn", signIn: { step: "code", opened: true } }, login: null, text: NOTE },
  "no-github-cli": { sending: { phase: "signIn", signIn: { step: "noGh" } }, login: null, text: NOTE },
  "writing-up": { sending: { phase: "working", step: "writing" }, login: "demo", text: NOTE },
  filing: { sending: { phase: "working", step: "filing" }, login: "demo", text: NOTE },
  failed: { sending: { phase: "failed", error: "Couldn’t reach GitHub." }, login: "demo", text: NOTE },
  sent: {
    sending: {
      phase: "done",
      results: [
        { kind: "bug", title: USAGE, outcome: "filed", number: 482 },
        { kind: "bug", title: STOP, outcome: "added", number: 417 },
        { kind: "idea", title: PIN, outcome: "filed", number: 483 },
      ],
    },
    login: "demo",
    text: NOTE,
  },
  "partly-sent": {
    sending: {
      phase: "done",
      results: [
        { kind: "bug", title: USAGE, outcome: "filed", number: 482 },
        { kind: "idea", title: PIN, outcome: "failed" },
      ],
    },
    login: "demo",
    text: NOTE,
  },
  "opened-in-browser": { sending: { phase: "done", results: [{ kind: "bug", title: USAGE, outcome: "opened" }] }, login: null, text: NOTE },
} satisfies Record<string, { sending: Sending; login: string | null; text: string }>;
type Screen = keyof typeof SCREENS;

const state = store<{ open: boolean; screen: Screen }>({ open: false, screen: "write-signed-out" });

export const openFeedback = (screen: Screen = "write-signed-out") => state.set({ open: true, screen });


export function FeedbackDialog() {
  const { open, screen } = state.use();
  const close = () => state.set({ open: false, screen });
  const focus = useRef<HTMLElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent showCloseButton={false} frame="max-w-feedback gap-0 p-0" initialFocus={focus}>
        <Feedback key={screen} sending={SCREENS[screen].sending} login={SCREENS[screen].login} initialText={SCREENS[screen].text} focusRef={(element) => void (focus.current = element)} onClose={close} />
      </DialogContent>
    </Dialog>
  );
}

function Feedback({ sending, login, initialText, focusRef, onClose }: { sending: Sending; login: string | null; initialText: string; focusRef: (element: HTMLElement | null) => void; onClose: () => void }) {
  const [text, setText] = useState(initialText);
  const done = sending.phase === "done" ? sending.results : null;
  const unsent = done?.filter((result) => result.outcome === "failed").length ?? 0;
  const working = sending.phase === "working";
  const signingIn = sending.phase === "signIn" ? sending.signIn : null;
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
  return (
    <>
      <div className="flex gap-3.5 ps-6 pe-5 pt-6 pb-4.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <DialogTitle>{!done ? "Send feedback" : unsent ? "Not all of it was sent" : browser ? "Ready to post" : "Thanks, it’s sent"}</DialogTitle>
          <DialogDescription>{line}</DialogDescription>
        </div>
        <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="Close" />}>
          <X />
        </DialogClose>
      </div>
      <div className="flex flex-col gap-3 px-6 pb-5.5">
        {done ? (
          <Results results={done} />
        ) : (
          <textarea
            ref={focusRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
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
        {signingIn && <GitHubSignIn signIn={signingIn} />}
        {sending.phase === "working" && (
          <ProgressLine
            icon={false}
            title="Writing up your reports…"
            description={sending.step === "writing" ? "Splitting your note and checking GitHub for ones already reported" : "Filing 3 reports on GitHub"}
            done={sending.step === "writing" ? 1 : 2}
            total={3}
            className="pt-1 text-muted-foreground"
          />
        )}
        {(sending.phase === "write" || sending.phase === "failed") && (
          <p className="min-h-4 text-xs text-muted-foreground">{login ? `Posts as @${login} on GitHub, with your app and macOS version.` : "Posts on GitHub once you sign in, with your app and macOS version."}</p>
        )}
        <ErrorLine error={sending.phase === "failed" ? `${sending.error} Your note is still here.` : null} />
      </div>
      <div className="flex items-center gap-2 border-t border-divider ps-3.5 pe-6 py-4">
        {!done && !working && (
          <Button variant="ghost" size="sm" className="text-muted-foreground">
            Write it on GitHub yourself
            <ArrowUpRight className="size-icon-sm" />
          </Button>
        )}
        <span className="flex-1" />
        {done && !unsent ? (
          <DialogClose render={<Button size="sm" ref={focusRef} />}>Done</DialogClose>
        ) : (
          <Button size="sm" disabled={waiting || !text.trim()} onClick={onClose}>
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
          <li key={result.title} className={cx("flex min-w-0 items-center gap-2.5 px-3 py-2", index > 0 && "border-t border-divider")}>
            <Icon aria-hidden={false} aria-label={result.kind === "bug" ? "Bug" : "Idea"} className="size-icon-md shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-label">{result.title}</span>
            {result.outcome === "failed" ? (
              <span className="shrink-0 text-label text-destructive">Not sent</span>
            ) : (
              <Button variant="link" size="inline" className="text-sm">
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
function GitHubSignIn({ signIn }: { signIn: SignIn }) {
  const noGh = signIn.step === "noGh";
  const chip = noGh ? INSTALL_GH : signIn.step === "code" ? CODE : null;
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
            <Button variant="ghost" size="sm">
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
