import { store } from "../onboarding/api";
import { selectTab } from "../shell/tab-store";
import { agentPage } from "./layer";
import { driverOf, isDriven, pausedFor, type SignInStop } from "./pause";

/**
 * Pages only the user goes through (main's browser/browserSignIn.ts), ported from the old app's browserSignIn: an
 * agent driving a tab stops at a sign-in page or a captcha, the tab comes to the front of its session, and the agent's
 * next call waits for Continue. Nothing resumes by itself. Agents never sign in or answer a challenge: Google's rules
 * forbid automation there, and their password rules wouldn't let them anyway.
 */
export type SignInSeen = { look?: boolean; stop?: SignInStop; rejected?: boolean };

/** The Browser tabs showing Google's refusal, in their page or a popup of theirs, whose card the user hasn't dismissed. */
const rejected = store<Record<string, true>>({});
export const useSignInRejected = (id: string): boolean => id in rejected.use();

export function dismissSignInRejected(tab: string): void {
  const { [tab]: _gone, ...rest } = rejected.get();
  rejected.set(rest);
}

/** The stop each tab last had: the user's Continue answers it, until its page stops being one. */
const answered = new Map<string, string>();

/** Stops the agent driving `tab` for `stop`, unless the user has already answered it. Whether it stopped now. */
export function stopAgent(tab: string, stop: SignInStop): boolean {
  if (!isDriven(tab) || answered.get(tab) === stop.key) return false;
  answered.set(tab, stop.key);
  pausedFor(tab, stop);
  // The tab's the user's now, so they need to see it. Only within its session: no window moves and no focus goes.
  const owner = driverOf(tab);
  if (owner) selectTab(owner.session, tab);
  return true;
}

/** The tab's page needs nobody, so a later sign-in on it is a new one. */
export const signInCleared = (tab: string) => answered.delete(tab);

/** What a page asks of the user now, looked into while an agent drives its tab. */
export const signInStopOf = (tab: string) => window.brigadierShell.agent({ call: "signInStop", guest: agentPage(tab).guest }) as Promise<SignInStop | null>;

export function signInSeen(tab: string, { look, stop, rejected: refused }: SignInSeen): void {
  if (refused === true) rejected.set({ ...rejected.get(), [tab]: true });
  if (refused === false) dismissSignInRejected(tab);
  if (stop) stopAgent(tab, stop);
  if (!look || !isDriven(tab)) return;
  signInStopOf(tab).then((found) => {
    if (found) stopAgent(tab, found);
    else signInCleared(tab);
  }).catch((error: unknown) => console.error("looking for a sign-in page failed", error));
}

/** What the agent hears in place of a page it stopped at: not the page, since the tab is the user's now. */
export function stoppedWords(stop: SignInStop, tab: string): string {
  const after = `The user has this tab now and nothing more was done here. Tell them what you need. Your next call on ${tab} waits until they press Done, hand it back.`;
  if (stop.kind === "ask") return `Asked the user: ${stop.what ?? ""}. ${after}`;
  if (stop.kind === "rejected") return `Stopped: Google refused this sign-in for this browser (${stop.site}). Agents can't help with that: only the user can decide what to do next. ${after}`;
  if (stop.kind === "captcha") return `Stopped: ${stop.site} shows a captcha. Agents never answer these, and only the user can. ${after}`;
  if (stop.window) return `Stopped: this page opened a separate sign-in window at ${stop.site}. You can't see or use that window, and agents don't sign in. ${after}`;
  return `Stopped: ${stop.site} is asking for a sign-in. Agents don't sign in: only the user does. ${after}`;
}
