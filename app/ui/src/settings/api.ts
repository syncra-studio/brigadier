import { useEffect } from "react";

import { useDaemon } from "../daemon";
import { errorText, run, store } from "../onboarding/api";

/** The app's settings as Rust keeps them, each with Rust's default [D71, D2004]. */
export type Settings = {
  follow_up: "queue" | "steer";
  default_level: "ask" | "auto" | "full";
  notify_finished: "background" | "always" | "never";
  notify_needs_you: boolean;
  sound: boolean;
  /** What the last notice did: none sent yet, went through, or macOS refused it [D2024]. */
  notices: "unasked" | "sent" | "blocked";
  awake: "off" | "work" | "always";
  /** Keeping awake holds with the lid closed too [D333]. */
  awake_lid: boolean;
  /** How many workers a family runs at once: a number, as Rust keeps it [D3001, D3007]. */
  workers: string;
  /** Each agent's own memory in sessions, off unless turned on; workers never [D2049]. */
  memory: boolean;
  /** Where web links and local dev URLs open: Brigadier's browser or the default one (Settings › Browser) [D507]. */
  web_links_in: "brigadier" | "system";
  local_links_in: "brigadier" | "system";
  /** An agent cursor shows where computer use acts; on unless turned off [D956]. */
  computer_cursor: boolean;
  /** Computer use leaves a browser's web pages to Brigadier's browser, unless the user names theirs; on unless turned off [D2032]. */
  computer_web: boolean;
  /** The thread's column centred or the pane's full width, and its messages in bubbles or stacked [D914, D915]. */
  thread_width: "centered" | "full";
  message_layout: "bubbles" | "stacked";
  /** The models starred in the model picker, as `<agent>/<id>`. */
  models_starred: string[];
};

const settings = store<{ value?: Settings; error?: string }>({});
export const useSettings = settings.use;
export const getSettings = () => settings.get().value;

// Rust's last word, and the changes still on their way, oldest first: what's shown is the one with the others on top.
let confirmed: Settings | undefined;
const pending: Partial<Settings>[] = [];
let saving: Promise<unknown> = Promise.resolve();
const show = () => confirmed && settings.set({ value: pending.reduce<Settings>((all, change) => ({ ...all, ...change }), confirmed) });

/** Asked on each connect until known; a failure keeps what was shown. */
export function loadSettings(): void {
  run(["settings"]).then(
    (reply) => {
      confirmed = reply as Settings;
      show();
    },
    (cause) => settings.get().value || settings.set({ error: errorText(cause) }),
  );
}

/**
 * Shown at once, saved one at a time so Rust's replies come in order; each reply keeps the changes still pending on
 * top, and a failure drops only its own change, and the caller says why [D30].
 */
export const setSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => saveShown({ [key]: value }, ["settings", key, String(value)]);

/** Bubbles or Stacked: the thread's width and its messages in one save, so a failure never leaves them apart [D914, D915]. */
export const setChatLayout = (mode: Settings["message_layout"]) =>
  saveShown({ thread_width: mode === "bubbles" ? "centered" : "full", message_layout: mode }, ["settings", "chat-layout", mode]);

/** Stars a model in the model picker, or takes its star off: shown at once, saved as `setSetting`. */
export function setStar(provider: string, id: string, on: boolean): Promise<void> {
  const model = `${provider}/${id}`;
  const others = (getSettings()?.models_starred ?? []).filter((each) => each !== model);
  return saveShown({ models_starred: on ? [...others, model] : others }, ["settings", "star", provider, id, on ? "on" : "off"]);
}

async function saveShown(change: Partial<Settings>, args: string[]): Promise<void> {
  pending.push(change);
  show();
  const save = saving.then(() => run(args));
  saving = save.catch(() => undefined);
  try {
    confirmed = (await save) as Settings;
  } finally {
    pending.splice(pending.indexOf(change), 1);
    show();
  }
}

/** How the lid stands, as Rust reads it: no rule yet, battery too low, sleep off now (Brigadier's or another app's), or ready [D333]. */
export type LidState = "setup" | "low" | "on" | "ready";
/** With the lid closed too, as the daemon pushes it: held now, this discharge's low-battery warning, and the sleep a low battery brought, until seen. */
export type LidHold = { held: boolean; warned: { at: number; percent: number } | null; slept: { at: number; percent: number } | null };
const lid = store<{ state?: LidState; settingUp?: boolean }>({});
/** Asked again as the daemon takes the lid's hold or lets it go, so a hint on screen stays true. */
export function useLid() {
  const held = useDaemon().lid?.held;
  useEffect(() => {
    if (held !== undefined) loadLid();
  }, [held]);
  return lid.use();
}

/** Asked as the Power row or the Keep awake menu shows; a failure keeps what was shown. */
export function loadLid(): void {
  run(["awake", "lid"]).then(
    (reply) => lid.set({ ...lid.get(), state: reply.lid as LidState }),
    (cause: unknown) => console.error(cause),
  );
}

/** The user has seen that a low battery slept the computer: Rust's next list drops it. */
export function seenSlept(at: number): void {
  run(["awake", "lid-seen", String(at)]).catch((cause: unknown) => console.error(cause));
}

let inSetup = false;

/** On or off; the first time on asks for the administrator password once, and without it stays off, as the old app. */
export async function setLid(on: boolean): Promise<void> {
  // Not yet known counts as no rule: Rust's lid-setup asks only when there isn't one.
  const state = lid.get().state;
  if (on && state !== "ready" && state !== "low") {
    // Before the switch shows waiting, a second click would set up twice, and its save could undo a later off.
    if (inSetup) return;
    inSetup = true;
    // Only a setup that takes a moment shows waiting: a rule already there answers at once, with no flash.
    const waiting = setTimeout(() => lid.set({ ...lid.get(), settingUp: true }), 300);
    try {
      lid.set({ state: (await run(["awake", "lid-setup"])).lid as LidState });
    } finally {
      clearTimeout(waiting);
      inSetup = false;
      lid.set({ ...lid.get(), settingUp: false });
    }
  }
  await setSetting("awake_lid", on);
  // The daemon applies it on its next pass.
  setTimeout(loadLid, 1000);
}

/** What the lid switch does, as it stands now: the old app's words. */
export function lidHint(settings: Settings, state: { state?: LidState; settingUp?: boolean }): string {
  if (state.settingUp) return "Waiting for the administrator password…";
  if (settings.awake === "off") return "Takes effect once keeping awake is on";
  if (state.state === "setup") return "Asks for your administrator password once";
  if (state.state === "low" && settings.awake_lid) return "The battery is low, so closing the lid sleeps the computer; plug it in";
  if (state.state === "on" && settings.awake_lid) return "Sleep is off, even with the lid closed; keep it plugged in";
  return "Applied whenever the computer is kept awake; best plugged in";
}
