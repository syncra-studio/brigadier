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
};

const settings = store<{ value?: Settings; error?: string }>({});
export const useSettings = settings.use;
export const getSettings = () => settings.get().value;

/** Asked on each connect until known; a failure keeps what was shown. */
export function loadSettings(): void {
  run(["settings"]).then(
    (reply) => settings.set({ value: reply as Settings }),
    (cause) => settings.get().value || settings.set({ error: errorText(cause) }),
  );
}

/** Shown at once, then Rust's reply replaces it; on failure it goes back, and the caller says why [D30]. */
export async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  const before = settings.get().value;
  if (before) settings.set({ value: { ...before, [key]: value } });
  try {
    settings.set({ value: (await run(["settings", key, String(value)])) as Settings });
  } catch (cause) {
    if (before) settings.set({ value: before });
    throw cause;
  }
}
