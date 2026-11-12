import { errorText, run, store } from "../onboarding/api";

/*
 * Send feedback, the old app's flow [D2100]: the user only writes. Rust writes the note up as one report per bug or
 * idea, checks GitHub for ones already reported, and files each as the user with their own `gh` (a repeat as a
 * comment there). Not signed in, Send signs `gh` in first, in place: its one-time code and Open GitHub, then it files
 * on its own once GitHub says yes. With no writer to run, Rust gives the note's prefilled page, opened in the browser.
 * Closing the dialog while it works doesn't stop the send; opening it again shows where that got to.
 */

export type Kind = "bug" | "idea";
/** A report as Rust wrote it up, filed again as it came. */
export type Report = { kind: Kind; title: string } & Record<string, unknown>;
/** What became of one report: filed, added to the issue it repeats, opened in the browser, or not sent. */
export type Result = { kind: Kind; title: string } & (
  | { outcome: "filed" | "added"; number: number; url: string }
  | { outcome: "opened" }
  | { outcome: "failed"; reason: string; report: Report }
);
/** Signing in to GitHub before a send: starting, its code to enter on `url` (`opened` once Open GitHub was pressed), or no GitHub CLI. */
export type SignIn = { step: "starting" } | { step: "code"; code: string; url: string; opened: boolean } | { step: "noGh" };
/** What a send is at: writing the note up (and looking for repeats), or filing `count` reports. */
export type Step = { step: "writing" } | { step: "filing"; count: number };
/**
 * Where a send is: still being written, signing in first, at work, done (some maybe failed), or failed before anything
 * was filed (`results` when the reports were written and all failed, so Try again files them again without writing
 * them up anew). A sign-in keeps the `results` it would file again.
 */
export type Sending =
  | { phase: "write" }
  | { phase: "signIn"; signIn: SignIn; results: Result[] | null }
  | { phase: "working"; step: Step }
  | { phase: "done"; results: Result[] }
  | { phase: "failed"; error: string; results: Result[] | null };
/** Who it posts as: signed in to GitHub with `gh` (and as whom), or not. */
export type Account = { signedIn: boolean; login: string | null };

type State = { open: boolean; text: string; sending: Sending; account: Account | null };
export const feedback = store<State>({ open: false, text: "", sending: { phase: "write" }, account: null });
const set = (next: Partial<State>) => feedback.set({ ...feedback.get(), ...next });

/** What the dialog says when nothing could be filed. */
export const COULDNT_REACH = "Couldn’t reach GitHub.";

/** Opens it; a send it was closed on keeps showing: at work, done, or failed with the note still there. */
export function openFeedback(): void {
  const busy = feedback.get().sending.phase !== "write";
  set(busy ? { open: true } : { open: true, text: "", sending: { phase: "write" } });
  void loadAccount();
}

/** The send now; one closed on (or before) is left to end on its own, unseen. */
let current = 0;

/** Closes it; a send at work carries on, and shows when it opens again. A sign-in stops. */
export function closeFeedback(): void {
  const { sending } = feedback.get();
  if (sending.phase === "working") return set({ open: false });
  if (sending.phase === "signIn") cancelSignIn();
  current += 1;
  set({ open: false, text: "", sending: { phase: "write" } });
}

/** The note as typed; once it changes, a failed send's reports are written up from it anew. */
export function setText(text: string): void {
  const { sending } = feedback.get();
  set((sending.phase === "failed" || sending.phase === "signIn") && sending.results ? { text, sending: { ...sending, results: null } } : { text });
}

let asked: Promise<void> | null = null;

/** Asks Rust who it posts as (each time it opens: a sign-in may have changed). */
function loadAccount(): Promise<void> {
  asked ??= run(["feedback", "account"])
    .then(
      (reply) => set({ account: { signedIn: reply.signed_in === true, login: reply.login ?? null } }),
      (cause) => console.warn("feedback: who it posts as is unknown", cause),
    )
    .finally(() => {
      asked = null;
    });
  return asked;
}

/** Why a sign-in to GitHub didn't sign in, in Rust's plain words. */
class SignInError extends Error {}

function cancelSignIn(): void {
  run(["feedback", "sign-in", "cancel"]).catch((cause) => console.warn("feedback: stopping the sign-in failed", cause));
}

/** Signs `gh` in, showing each step: its code until GitHub says yes. False when there is no GitHub CLI. */
async function signIn(show: (step: SignIn) => void): Promise<boolean> {
  show({ step: "starting" });
  try {
    const started = await run(["feedback", "sign-in"]);
    if (started.state === "no-gh") {
      show({ step: "noGh" });
      return false;
    }
    if (started.state === "code") {
      show({ step: "code", code: started.code, url: started.url, opened: false });
      await run(["feedback", "sign-in", "wait"]);
    }
  } catch (cause) {
    throw new SignInError(errorText(cause) || "Signing in to GitHub didn’t finish. Try again.");
  }
  set({ account: { signedIn: true, login: null } });
  void loadAccount();
  return true;
}

/** Open GitHub: the sign-in's page, and from then on it shows it waits. */
export function openSignIn(): void {
  const { sending } = feedback.get();
  if (sending.phase !== "signIn" || sending.signIn.step !== "code") return;
  window.brigadier?.openLink(sending.signIn.url);
  set({ sending: { ...sending, signIn: { ...sending.signIn, opened: true } } });
}

/** Whether a send signs in first: known signed out, or still at a sign-in step; when unknown, once Rust says. */
async function signInFirst(sending: Sending): Promise<boolean> {
  if (sending.phase === "signIn") return true;
  if (!feedback.get().account) await loadAccount();
  return !(feedback.get().account?.signedIn ?? false);
}

/** Files `reports` as the user; signed out, none is, and the account shows signed out (Try again signs in). */
async function file(reports: Report[]): Promise<Result[]> {
  const reply = await run(["feedback", "file", JSON.stringify(reports)]);
  if (reply.signed_in === false) set({ account: { signedIn: false, login: null } });
  return (reply.results as Result[]).map((result, index) => (result.outcome === "failed" ? { ...result, report: reports[index]! } : result));
}

/** Files the reports that failed again; the others stay as they were. */
async function retry(results: Result[]): Promise<Result[]> {
  const again = await file(results.flatMap((result) => (result.outcome === "failed" ? [result.report] : [])));
  let index = 0;
  return results.map((result) => (result.outcome === "failed" ? (again[index++] ?? result) : result));
}

/** Done, unless every report failed: then nothing was sent. */
function outcomeOf(results: Result[]): Sending {
  const failed = results.flatMap((result) => (result.outcome === "failed" ? [result] : []));
  if (failed.length < results.length) return { phase: "done", results };
  const reason = failed[0]?.reason;
  return { phase: "failed", error: reason ? `Couldn’t send it: ${reason}.` : COULDNT_REACH, results };
}

/** Send (or Try again): signs in first when it has to, writes the note up, files it; a Try again files only what failed. */
export function sendFeedback(): void {
  const { text, sending } = feedback.get();
  const failed = sending.phase === "done" || sending.phase === "failed" || sending.phase === "signIn" ? sending.results : null;
  const mine = ++current;
  const show = (next: Sending) => mine === current && set({ sending: next });
  const go = async (): Promise<Result[] | null> => {
    if ((await signInFirst(sending)) && !(await signIn((step) => show({ phase: "signIn", signIn: step, results: failed })))) return null;
    // Closed (or sent again) while it asked or signed in: this send stops there.
    if (mine !== current) return null;
    if (failed) {
      show({ phase: "working", step: { step: "filing", count: failed.filter((result) => result.outcome === "failed").length } });
      return retry(failed);
    }
    show({ phase: "working", step: { step: "writing" } });
    const written = await run(["feedback", "write", text]);
    if (written.opened) {
      window.brigadier?.openLink(written.opened.url);
      return [{ kind: written.opened.kind, title: written.opened.title, outcome: "opened" }];
    }
    show({ phase: "working", step: { step: "filing", count: written.reports.length } });
    return file(written.reports);
  };
  go().then(
    (results) => results && show(outcomeOf(results)),
    (cause) => {
      console.warn("feedback: sending failed", cause);
      show({ phase: "failed", error: cause instanceof SignInError ? cause.message : COULDNT_REACH, results: failed });
    },
  );
}
