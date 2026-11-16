import { useEffect, useState, useSyncExternalStore } from "react";

import { showToast } from "../components/toast";
import { run } from "../onboarding/api";
import { allTabs, openTab, setTabProfile, tabsOf } from "../shell/tab-store";
import { go } from "./layer";
import { closeBrowserPage, pageReady, reopenPage } from "./pages";

/*
 * The browser's profiles, the old app's browserProfiles [D515]: the list, the default, and which profile each
 * session is on. Rust keeps them (crates/cli/src/browser/profiles.rs); this shows a change at once and takes
 * Rust's answer. A session's new tabs open on its profile, else its parent's (a worker's, a fork's, a side chat's),
 * else the default; a tab stays on the profile it opened on until the user moves it.
 */

/** A profile: its own partition, a colour (`--glyph-1` to `--glyph-8`) and a name whose first letter marks it. */
export type BrowserProfile = { id: string; name: string; hue: number; deleting?: boolean };
type Places = { profiles: BrowserProfile[]; defaultId: string; sessions: Record<string, string> };

/** The colours in the order new profiles take them. */
export const HUES = [6, 4, 1, 5, 2, 3, 7, 8] as const;

let places: Places = { profiles: [{ id: "default", name: "Personal", hue: 6 }], defaultId: "default", sessions: {} };
/** Goes up with every change: what a session resolves to is read again. */
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener));

function land(next: Places): void {
  places = { profiles: next.profiles, defaultId: next.defaultId, sessions: next.sessions };
  version += 1;
  resolved.clear();
  for (const listener of listeners) listener();
}

const profilesRun = (args: string[], session = "-") => run(["browser", session, "profiles", ...args]).then((reply) => (land(reply as Places), reply));

/** Shown at once, then Rust's answer; a refusal says why and reads the list again. */
function change(local: (now: Places) => Places, args: string[], session?: string): Promise<unknown> {
  land(local(places));
  return profilesRun(args, session).catch((error: unknown) => {
    showToast(error instanceof Error ? error.message : String(error), { tone: "error" });
    void profilesRun(["list"]);
  });
}

let loading: Promise<void> | null = null;
/** Read once; a delete a crash cut short finishes then. */
export function loadProfiles(): Promise<void> {
  loading ??= profilesRun(["list"]).then(
    () => {
      for (const profile of places.profiles) if (profile.deleting) finishDeleting(profile.id).catch((error: unknown) => console.error("finishing a profile's delete failed", error));
    },
    (error: unknown) => console.error("reading the browser's profiles failed", error),
  );
  return loading;
}

/** The list without those being deleted: one array per list, since a hook's answer is compared by identity. */
const liveLists = new WeakMap<BrowserProfile[], BrowserProfile[]>();
function live(profiles: BrowserProfile[]): BrowserProfile[] {
  let list = liveLists.get(profiles);
  if (!list) liveLists.set(profiles, (list = profiles.filter((profile) => !profile.deleting)));
  return list;
}

export const allProfiles = (): BrowserProfile[] => live(places.profiles);
const defaultOf = (): BrowserProfile => allProfiles().find((profile) => profile.id === places.defaultId) ?? allProfiles()[0]!;
export const known = (id: string | undefined): string | null => (id && allProfiles().some((profile) => profile.id === id) ? id : null);
export const nameOf = (id: string): string => allProfiles().find((profile) => profile.id === id)?.name ?? id;

export function useProfiles(): BrowserProfile[] {
  useEffect(() => void loadProfiles(), []);
  return useSyncExternalStore(subscribe, allProfiles);
}
export const useDefaultProfile = (): BrowserProfile => useSyncExternalStore(subscribe, defaultOf);
export const useSessionPicks = (): Record<string, string> => useSyncExternalStore(subscribe, () => places.sessions);

/** What each session resolves to, by Rust, which walks its parents; read again after every change. */
const resolved = new Map<string, Promise<string>>();
function sessionProfile(session: string): Promise<string> {
  let found = resolved.get(session);
  if (!found) {
    found = run(["browser", session, "profiles", "resolve"]).then((reply) => String(reply.profile), () => defaultOf().id);
    resolved.set(session, found);
  }
  return found;
}

/** The profile a session's new tabs open on; the default until Rust has said. */
export function useSessionProfile(session: string): string {
  const at = useSyncExternalStore(subscribe, () => version);
  const [shown, setShown] = useState<{ at: number; session: string; id: string } | null>(null);
  useEffect(() => {
    let current = true;
    void sessionProfile(session).then((id) => current && setShown({ at, session, id }));
    return () => {
      current = false;
    };
  }, [session, at]);
  return known(shown?.session === session ? shown.id : undefined) ?? defaultOf().id;
}

/** The profile tab `id`'s page opens on, from now on its own, and its session's if it had none. */
export async function pinTab(owner: string, id: string): Promise<string> {
  await loadProfiles();
  const pinned = known(tabsOf(owner).tabs.find((tab) => tab.id === id)?.profile);
  if (pinned) return pinned;
  const profile = String((await run(["browser", owner, "profiles", "resolve", id])).profile);
  setTabProfile(owner, id, profile);
  if (!places.sessions[owner]) await pickSession(owner, profile);
  return profile;
}

const pickSession = (session: string, profile: string) =>
  change((now) => ({ ...now, sessions: { ...now.sessions, [session]: profile } }), ["session-pick", profile], session);

/**
 * Picks `profile` from the toolbar or a key: the tab in front reopens on it and the session's new tabs follow; other
 * tabs stay. A tab an agent drives isn't pulled from under it: a New tab opens instead, and the agent's next tabs
 * follow. A partition can't change on a live page, so the page is made again at its address. `keyboard`: the page
 * had the keyboard, and keeps it.
 */
export async function switchProfile(owner: string, profile: string, { keyboard = false } = {}): Promise<void> {
  if (!known(profile)) return;
  const { tabs, active } = tabsOf(owner);
  const tab = tabs.find((each) => each.id === active);
  void pickSession(owner, profile);
  if (tab?.kind !== "browser") {
    if (tab?.kind !== "new") showToast(`New tabs in this session open in ${nameOf(profile)}`);
    return;
  }
  const current = known(tab.profile) ?? (await sessionProfile(owner));
  if (current === profile) return;
  if (tab.driver) {
    if (!tab.profile) setTabProfile(owner, tab.id, current);
    openTab(owner, "new");
    return;
  }
  profileChanged({ tabId: tab.id, from: current, to: profile });
  setTabProfile(owner, tab.id, profile);
  reopenPage(tab.id, keyboard);
}

export function createProfile(name: string, hue: number): Promise<string> {
  return profilesRun(["create", name.trim(), "--hue", String(hue)]).then((reply) => String(reply.profile));
}

export const renameProfile = (id: string, name: string) =>
  change((now) => ({ ...now, profiles: now.profiles.map((each) => (each.id === id ? { ...each, name: name.trim() } : each)) }), ["rename", id, name.trim()]);
export const recolourProfile = (id: string, hue: number) =>
  change((now) => ({ ...now, profiles: now.profiles.map((each) => (each.id === id ? { ...each, hue } : each)) }), ["recolour", id, String(hue)]);
export const makeDefaultProfile = (id: string) => change((now) => ({ ...now, defaultId: id }), ["make-default", id]);

/** Moves a profile to `to` among the live ones, as the list shows them. */
export function moveProfile(id: string, to: number): void {
  const at = places.profiles.indexOf(allProfiles()[to]!);
  change((now) => {
    const moved = now.profiles.find((each) => each.id === id);
    if (!moved) return now;
    const rest = now.profiles.filter((each) => each !== moved);
    rest.splice(at, 0, moved);
    return { ...now, profiles: rest };
  }, ["move", id, String(at)]);
}

/** The sessions on `id`: those that opened a page on it or picked it, and still exist. */
export const sessionsOn = (id: string, picks: Record<string, string>, sessions: ReadonlySet<string>): number =>
  Object.entries(picks).filter(([session, profile]) => profile === id && sessions.has(session)).length;

const browserTabsOn = (id: string) => allTabs().filter(({ tab }) => tab.kind === "browser" && tab.profile === id);
/** The open tabs on `id`. */
export const tabsOn = (id: string): number => browserTabsOn(id).length;

/** A profile's cookies went: its open pages show that at once, signed out. */
export function reloadProfileTabs(id: string): void {
  for (const { tab } of browserTabsOn(id)) if (pageReady(tab.id)) go(tab.id, "reload");
}

/** Whether a profile can be deleted: not the last one, nor the default, which can only be cleared. */
export const canDelete = (id: string): boolean => allProfiles().length > 1 && id !== places.defaultId;

/** A tab an agent may be working was moved to another profile. Said once per tab, before its page goes. */
export type ProfileChange = { tabId: string; from: string; to: string };
const profileChangeListeners = new Set<(change: ProfileChange) => void>();

/** For the agent's side of the browser: its refs and page state don't survive the move. */
export function onProfileChanged(listener: (change: ProfileChange) => void): () => void {
  profileChangeListeners.add(listener);
  return () => profileChangeListeners.delete(listener);
}

export function profileChanged(change: ProfileChange): void {
  for (const listener of profileChangeListeners) listener(change);
}

/** Main clears what Chromium holds, then Rust drops the entry and the profile's own folder. */
async function finishDeleting(id: string): Promise<void> {
  await window.brigadierShell.profiles("remove", { profile: id });
  await profilesRun(["forget", id]);
}

/**
 * Deletes a profile. Rust marks it deleting with its sessions already on the default, in one save, so nothing new
 * opens on it and a crash from here on still finishes. Then its tabs move to the default and their pages close: one
 * in front opens again at once, one behind when it's shown, its old title (which may name the account) gone.
 */
export async function deleteProfile(id: string): Promise<void> {
  if (!canDelete(id)) return;
  await profilesRun(["delete-mark", id]);
  const to = defaultOf().id;
  for (const { owner, tab } of browserTabsOn(id)) {
    profileChanged({ tabId: tab.id, from: id, to });
    setTabProfile(owner, tab.id, to);
    closeBrowserPage(tab.id);
  }
  await finishDeleting(id);
}

/** What a profile holds, by its session's own store. */
export type ProfileCounts = { signIns: number };
export const profileCounts = (id: string): Promise<ProfileCounts> => window.brigadierShell.profiles("counts", { profile: id }) as Promise<ProfileCounts>;

/** What main saw of a profile's cookies and sites (browserClearData.ts), dated in Rust for Clear's time ranges. */
export function recordDates({ profile, ...seen }: { profile: string; cookies: unknown[]; sites: unknown[] }): void {
  run(["browser", "-", "dates", "record", JSON.stringify(seen), "--profile", profile]).catch(() => {
    // A profile on its way out refuses: what it saw goes with it.
  });
}
