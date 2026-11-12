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
  /** How many workers a family runs at once: a number, as Rust keeps it [D3001, D3007]. */
  workers: string;
  /** The models starred in the model picker, as `<agent>/<id>`. */
  models_starred: string[];
};

const settings = store<{ value?: Settings; error?: string }>({});
export const useSettings = settings.use;
export const getSettings = () => settings.get().value;

// Rust's last word, and the changes still on their way, oldest first: what's shown is the one with the others on top.
let confirmed: Settings | undefined;
const pending: { key: keyof Settings; value: unknown }[] = [];
let saving: Promise<unknown> = Promise.resolve();
const show = () => confirmed && settings.set({ value: pending.reduce((all, { key, value }) => ({ ...all, [key]: value }), confirmed) });

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
export const setSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => saveShown(key, value, ["settings", key, String(value)]);

/** Stars a model in the model picker, or takes its star off: shown at once, saved as `setSetting`. */
export function setStar(provider: string, id: string, on: boolean): Promise<void> {
  const model = `${provider}/${id}`;
  const others = (getSettings()?.models_starred ?? []).filter((each) => each !== model);
  return saveShown("models_starred", on ? [...others, model] : others, ["settings", "star", provider, id, on ? "on" : "off"]);
}

async function saveShown<K extends keyof Settings>(key: K, value: Settings[K], args: string[]): Promise<void> {
  const change = { key, value };
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
