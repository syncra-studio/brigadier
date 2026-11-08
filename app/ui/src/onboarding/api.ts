import { useSyncExternalStore } from "react";

import { ask } from "../daemon";

/** A CLI command through the daemon [D40]; the reply's `error` (or `message`) on failure. */
export function run(args: string[]): Promise<Record<string, any>> {
  return new Promise((resolve, reject) =>
    ask({ op: "run", args }, (reply) => (reply.ok ? resolve(reply) : reject(new Error(reply.message ?? reply.error)))),
  );
}

declare global {
  interface Window {
    /** What main does for the page beyond supervising (preload.ts): the folder picker and the intro's staging. */
    brigadier?: {
      pickFolder(): Promise<string | null>;
      /** Folders picked, several with `multi`, starting at `at` (`~/` is home); none when cancelled. */
      pickFolders(options?: { at?: string; multi?: boolean }): Promise<string[]>;
      /** The app menu's commands for the page: "open-folders" (with the paths picked), "add-project", "new-session". */
      onMenu(listener: (command: string, paths?: string[]) => void): () => void;
      introBegin(): Promise<boolean>;
      introShaped(): Promise<void>;
      introFinish(fadeMs: number): Promise<void>;
      introRelease(): Promise<void>;
      onIntroEnded(listener: () => void): () => void;
    };
  }
}

/** The first launch's window staging (main's intro.ts); outside the app's window, nothing happens. */
export const intro = {
  begin: async () => (await window.brigadier?.introBegin()) ?? false,
  shaped: () => window.brigadier?.introShaped(),
  finish: (fadeMs: number) => window.brigadier?.introFinish(fadeMs),
  release: () => window.brigadier?.introRelease(),
  onEnded: (listener: () => void) => window.brigadier?.onIntroEnded(listener) ?? (() => {}),
};

export const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

type Store<T> = { get: () => T; set: (next: T) => void; use: () => T };
export function store<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    get: () => value,
    set(next) {
      value = next;
      for (const listener of listeners) listener();
    },
    use: () => useSyncExternalStore(subscribe, () => value),
  };
}

/** One agent as Rust checked it [D45]: each adapter says how it is found, installed and signed in. */
export type Agent = {
  name: string;
  label: string;
  install: boolean;
  sign_in: string | null;
  /** Its mark, one SVG from its adapter [D118, D123]; none: a generic terminal. */
  mark: string | null;
  setup: { id: string; action: "install" | "sign-in"; running: boolean; code: number | null; signal: number | null; code_page: string | null } | null;
  path?: string | null;
  version?: string | null;
  signed_in?: boolean;
  how?: string | null;
  models?: { id: string; local: boolean }[];
  error?: string;
};

/** Static or saved cards arrive with the profile; live checks replace them by name. */
type Agents = { list?: Agent[]; checking: ReadonlySet<string>; error?: string };
const agents = store<Agents>({ checking: new Set() });
export const useAgents = agents.use;

// Each agent's last shown check: an older reply never lands over a newer one. "*" is every agent.
const shown = new Map<string, number>();
const inFlight = new Map<string, number>();
let seq = 0;

function check(args: string[], name = "*"): Promise<void> {
  const mine = ++seq;
  inFlight.set(name, (inFlight.get(name) ?? 0) + 1);
  const checking = () => new Set([...inFlight].filter(([, count]) => count > 0).map(([each]) => each));
  agents.set({ ...agents.get(), checking: checking() });
  const done = (next: Partial<Agents>) => {
    inFlight.set(name, inFlight.get(name)! - 1);
    agents.set({ ...agents.get(), ...next, checking: checking() });
  };
  return run(args).then(
    (reply) => {
      const fresh = (reply.agents as Agent[]).filter((agent) => mine > (shown.get(agent.name) ?? 0));
      for (const agent of fresh) shown.set(agent.name, mine);
      const list = agents.get().list;
      if (name === "*") {
        // A full check keeps Rust's order; a newer reply keeps its last card.
        const next = (reply.agents as Agent[]).flatMap((agent) => (fresh.includes(agent) ? [agent] : (list?.filter((each) => each.name === agent.name) ?? [])));
        return done({ list: next, error: undefined });
      }
      if (!list) return done({});
      done({ list: list.map((agent) => fresh.find((each) => each.name === agent.name) ?? agent), error: undefined });
    },
    (cause) => done({ error: errorText(cause) }),
  );
}

/**
 * Checks every agent, reading the login shell again first (an install may have changed it). With
 * `cached`, the last checks Rust kept land first, at once [D30].
 */
export const checkAll = (cached = false) =>
  cached ? Promise.all([check(["agents", "--cached"]), check(["agents"])]).then(() => {}) : check(["agents"]);
/** Checks one agent again: after its setup run moves, or Retry. */
export const checkOne = (name: string) => check(["agents", name], name);

/** What onboarding keeps [D45]: undefined until loaded. */
export type Profile = { name: string; intro_seen: boolean; onboarded: boolean };
const profile = store<{ value?: Profile; error?: string }>({});
export const useProfile = profile.use;

export function loadProfile(): void {
  run(["profile"]).then(
    (reply) => {
      agents.set({ ...agents.get(), list: reply.agents as Agent[] });
      profile.set({ value: reply as Profile });
      void checkAll();
    },
    (cause) => profile.get().value || profile.set({ error: errorText(cause) }),
  );
}

/** The native folder picker, then the picked folder's repository as a project would take it, or null; nothing is added yet. */
export async function pickRepo(): Promise<string | null> {
  const picked = await window.brigadier?.pickFolder();
  return picked ? ((await run(["projects", "--check", picked])).repo as string) : null;
}

/**
 * Changes the profile: shown at once, then the reply replaces it; on failure it goes back and
 * the error is thrown for the screen to show [D30].
 */
export async function setProfile(args: string[], shown: Partial<Profile>): Promise<Profile> {
  const before = profile.get().value;
  if (before) profile.set({ value: { ...before, ...shown } });
  try {
    const reply = (await run(["profile", ...args])) as Profile;
    profile.set({ value: reply });
    return reply;
  } catch (cause) {
    profile.set({ value: before });
    throw cause;
  }
}
