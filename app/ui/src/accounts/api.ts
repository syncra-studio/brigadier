import { useSyncExternalStore } from "react";

import type { Run } from "../onboarding/agents";
import { errorText, run } from "../onboarding/api";

/** One account as Rust checked it in its own home [D51]; `id` "" is the computer's own login. */
export type Account = {
  id: string;
  name: string;
  check: {
    installed: boolean;
    signed_in?: boolean | null;
    how?: string;
    /** Who signed in, where its CLI says: email, plan ("max") and organization. */
    email?: string | null;
    plan?: string | null;
    org?: string | null;
    kept_apart?: boolean;
    models?: string[];
    /** Its usage limits, shortest window first; null where they weren't read [D28]. */
    usage?: Limit[] | null;
    error?: string;
  };
  /** An added account the computer's own login is signed in to as well: one row, saying so. */
  own_login?: boolean;
  /** Until when an automatic switch skips it: its limit's reset, as its CLI said, or 5 hours on [D74]. */
  /** Until when an automatic switch skips it: its limit's reset as its CLI said, or 5 hours on [D74]. */
  limited_until: number | null;
  /** Its sign-in run, read as the setup's own [D29]. */
  sign_in: Run | null;
};

/** One usage limit: its name ("5-hour", "Weekly · Opus"), the whole percent used, and when it resets (ms). */
export type Limit = { name: string; used: number; resets: number | null };

/** An agent with its switching settings; `accounts` is null for one that keeps one login. `use`: the account new sessions start on. */
export type SwitchAgent = {
  name: string;
  label: string;
  installed: boolean;
  accounts: { vendor: string; auto: boolean; use: string; list: Account[] } | null;
};

type State = { agents?: SwitchAgent[]; switchAgents?: boolean; error?: string; loading: boolean };

let state: State = { loading: false };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const useAccounts = () => useSyncExternalStore(subscribe, () => state);

// The newest reply wins: an older one never lands over a newer one, and slow checks that overlap
// still land in turn.
let asked = 0;
let landed = 0;

/** Every agent's accounts, each checked in its own home. The last list stays while it loads. */
export function loadAccounts(): Promise<void> {
  const mine = ++asked;
  set({ loading: true });
  const land = (next: Partial<State>) => {
    if (mine <= landed) return;
    landed = mine;
    set({ ...next, loading: mine < asked });
  };
  return run(["accounts"]).then(
    (reply) => land({ agents: reply.agents, switchAgents: reply.switch_agents, error: undefined }),
    (cause) => land({ error: errorText(cause) }),
  );
}

/** A setting of the accounts: shown at once, then the list again; on failure it goes back and throws [D30]. */
async function setAccounts(args: string[], shown: (agents: SwitchAgent[]) => Partial<State>): Promise<void> {
  const before = state;
  if (state.agents) set(shown(state.agents));
  try {
    await run(args);
  } catch (cause) {
    set({ agents: before.agents, switchAgents: before.switchAgents });
    throw cause;
  }
  void loadAccounts();
}

/** Turns an agent's account switching on or off, shown at once. */
export const setAuto = (name: string, on: boolean) =>
  setAccounts(["switching", "--agent", name, "--auto", on ? "on" : "off"], (agents) => ({
    agents: agents.map((agent) => (agent.name !== name ? agent : { ...agent, accounts: agent.accounts && { ...agent.accounts, auto: on } })),
  }));

export const setAgents = (on: boolean) => setAccounts(["switching", "--agents", on ? "on" : "off"], () => ({ switchAgents: on }));

/** One agent's accounts changed at once by `change`. */
const changed = (name: string, change: (accounts: NonNullable<SwitchAgent["accounts"]>) => NonNullable<SwitchAgent["accounts"]>) => (agents: SwitchAgent[]) => ({
  agents: agents.map((agent) => (agent.name !== name || !agent.accounts ? agent : { ...agent, accounts: change(agent.accounts) })),
});

/** New sessions of `agent` start on the account `id` ("" the computer's login); sessions already made stay where they are [D2082]. */
export const startOn = (agent: string, id: string) => setAccounts(["accounts", "use", agent, id], changed(agent, (accounts) => ({ ...accounts, use: id })));

/** Names an account; emptied, Rust gives it back its own name [D2082]. */
export const renameAccount = (agent: string, id: string, name: string) =>
  setAccounts(
    ["accounts", "rename", agent, id, name],
    changed(agent, (accounts) => ({ ...accounts, list: accounts.list.map((account) => (account.id === id ? { ...account, name: name.trim() } : account)) })),
  );

/** The account's sign-in run id, as Rust names it. */
export const signInRun = (agent: string, id: string) => `setup-${agent}-${id}`;

/** Wide, so a link its CLI prints stays on one line (the setup's own size). */
const SIZE = ["--cols", "500", "--rows", "10"];

/** Adds an account and opens its sign-in, the setup's own; returns the new account's id. */
export async function addAccount(agent: string): Promise<string> {
  const reply = await run(["accounts", "add", agent, ...SIZE]);
  void loadAccounts();
  return reply.account as string;
}

/** Signs an added account in again, with the setup's own sign-in in its folder [D29]. */
export async function signIn(agent: string, id: string): Promise<void> {
  await run(["setup", agent, "sign-in", "--account", id, ...SIZE]);
  void loadAccounts();
}

export const closeSignIn = (agent: string, id: string) => run(["setup", agent, "close", "--account", id]).then(() => loadAccounts());

/** Removes an account; Rust refuses while a session runs on it and says why. */
export async function removeAccount(id: string): Promise<string | null> {
  const reply = await run(["accounts", "remove", id]);
  await loadAccounts();
  return (reply.note as string | null) ?? null;
}

/**
 * Switches a session at its limit to `account` ("" is the computer's login); no account: a new conversation with a
 * hand-off; `auto`: wherever the automatic switch's settings allow, its Try again [D51].
 */
export const switchSession = (session: string, account?: string, auto = false) =>
  run(["switch", session, ...(account === undefined ? [] : ["--account", account]), ...(auto ? ["--auto"] : [])]);
