import { useSyncExternalStore } from "react";

import { run } from "../onboarding/api";
import { tabAnywhere } from "../shell/tab-store";

/**
 * The user's takeover of an agent's browser tab, ported from the old app's agentPause: the user's own input in the
 * tab, its page or its toolbar, pauses the agent working it; Continue hands it back. Kept here, apart from the page,
 * so the page loading again can't undo it. The daemon holds the agent's calls on a paused tab.
 */
/** A page only the user goes through: a sign-in, a captcha or Google's refusal (main's browser/browserSignInRules.ts). */
export type SignInStop = { kind: "signIn" | "captcha" | "rejected"; site: string; key: string; window?: boolean };
type Pause = { paused: Record<string, string>; devtools: Record<string, true>; asked: Record<string, SignInStop> };
let state: Pause = { paused: {}, devtools: {}, asked: {} };
const listeners = new Set<() => void>();
const set = (change: (now: Pause) => Partial<Pause>) => {
  state = { ...state, ...change(state) };
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener));
export const useAgentPause = (): Pause => useSyncExternalStore(subscribe, () => state);

/** Hears each change of the pauses, with what they were before (the agent's side lets go and takes back its hold). */
export function onPauseChanged(listener: (now: Pause, before: Pause) => void): () => void {
  let before = state;
  return subscribe(() => {
    const was = before;
    before = state;
    listener(state, was);
  });
}

/** The agent working browser tab `id`, with its session; null for the user's own tabs. */
export function driverOf(id: string): { session: string; driver: string } | null {
  const found = tabAnywhere(id);
  return found?.tab.kind === "browser" && found.tab.driver ? { session: found.owner, driver: found.tab.driver } : null;
}

/** Whether an agent is driving browser tab `id`: it has the tab and the user hasn't taken it over. */
export const isDriven = (id: string): boolean => driverOf(id) !== null && !(id in state.paused);

export const isPaused = (id: string): boolean => id in state.paused;

/** DevTools is open on the tab: a call gets `devtools_open` at once, and reads of its activity go on. */
export const devToolsOpen = (id: string): boolean => id in state.devtools;

function tell(session: string, tab: string, paused: boolean): void {
  run(["browser", session, "paused", tab, String(paused)]).catch((error: unknown) => console.error("telling the daemon about a paused tab failed", error));
}

/** The user clicked, typed or scrolled in tab `id`, or used its toolbar: an agent's tab pauses. */
export function userUsed(id: string): void {
  if (isPaused(id)) return;
  const owner = driverOf(id);
  if (!owner) return;
  set(({ paused }) => ({ paused: { ...paused, [id]: owner.session } }));
  tell(owner.session, id, true);
}

/** The page only the user goes through that tab `id`'s agent stopped at, until Continue. */
export const askedOf = (id: string): SignInStop | undefined => state.asked[id];

/** The agent working tab `id` stopped at a page only the user goes through (sign-in.ts). */
export function pausedFor(id: string, stop: SignInStop): void {
  if (isPaused(id)) return;
  const owner = driverOf(id);
  if (!owner) return;
  set(({ paused, asked }) => ({ paused: { ...paused, [id]: owner.session }, asked: { ...asked, [id]: stop } }));
  tell(owner.session, id, true);
}

/**
 * DevTools opened or closed on tab `id`. Opening it on an agent's tab counts as taking it over. Closing it resumes
 * nothing: the agent waits for Continue again. The daemon holds a paused tab's calls, so it hears of the pause only
 * while DevTools is shut: while open, the calls come here and are answered.
 */
export function devToolsChanged(id: string, open: boolean): void {
  if (open === devToolsOpen(id)) return;
  const owner = driverOf(id);
  if (open) {
    const was = isPaused(id);
    set(({ paused, devtools }) => ({ devtools: { ...devtools, [id]: true }, paused: owner ? { ...paused, [id]: owner.session } : paused }));
    if (owner && was) tell(owner.session, id, false);
    return;
  }
  set(({ devtools }) => {
    const { [id]: _gone, ...rest } = devtools;
    return { devtools: rest };
  });
  if (owner && isPaused(id)) tell(owner.session, id, true);
}

/** The browser tabs whose page shows now. */
const showing = new Set<string>();

/** Tab `id`'s page shows over its tab, or stops showing (its tab went behind, closed). */
export function pageShows(id: string, shows: boolean): void {
  if (shows) showing.add(id);
  else showing.delete(id);
}

/**
 * The page of tab `id` heard the user's click, key or scroll. Only a page that shows can be the user's: one behind
 * its tab (an agent's tab the user never opened) hears keys and scrolls meant for the app, which would pause its agent.
 */
export function pageUsed(id: string): void {
  if (showing.has(id)) userUsed(id);
}

/** Continue: the agent goes on in tab `id`; also when the tab closes. */
export function handBack(id: string): void {
  const session = state.paused[id];
  if (session === undefined) return;
  set(({ paused, devtools, asked }) => {
    const { [id]: _gone, ...rest } = paused;
    const { [id]: _open, ...shut } = devtools;
    const { [id]: _stop, ...others } = asked;
    return { paused: rest, devtools: shut, asked: others };
  });
  tell(session, id, false);
}
