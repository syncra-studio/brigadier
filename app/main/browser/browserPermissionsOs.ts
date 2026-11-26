// The system's side of a site permission, after the person's yes to Brigadier's card: its own question, then its
// answer. Electron doesn't ask for location, and Chromium waits on macOS's answer, so Brigadier asks macOS itself through
// the panel addon (the old app's native ask, D516) and answers the page once macOS has [C68].
import { shell, systemPreferences } from "electron";

import { type LocationStatus, type LocationWhy, locationRefusal } from "./browserPermissionsRules";
import type { SiteAsk } from "./profiles";

export type LocationAddon = { locationStatus?: () => LocationStatus; locationAuthorization?: () => LocationStatus; locationAsk?: () => void };
let addon: () => LocationAddon | undefined = () => undefined;
/** The panel addon's getter, which loads it: a page may ask before the addon's warm-up. */
export const useLocationAddon = (get: () => LocationAddon | undefined) => void (addon = get);

export type OsDevice = "camera" | "microphone" | "location";

const SETTINGS_PANE: Record<OsDevice, string> = {
  camera: "Privacy_Camera",
  microphone: "Privacy_Microphone",
  location: "Privacy_LocationServices",
};

/** Asks the system for what the person just allowed; what it refuses, has off, or leaves unanswered comes back by name. */
export async function refusedByOs(asked: SiteAsk): Promise<{ refused: OsDevice[]; why?: LocationWhy }> {
  if (process.platform !== "darwin") return { refused: [] };
  const refused: OsDevice[] = [];
  for (const device of ["camera", "microphone"] as const) {
    if (asked[device] && !(await systemPreferences.askForMediaAccess(device))) refused.push(device);
  }
  if (!asked.location) return { refused };
  const { locationStatus, locationAuthorization, locationAsk } = addon() ?? {};
  const why = locationStatus && locationAuthorization && locationAsk ? await locationRefusal(locationStatus, locationAuthorization, locationAsk) : "unavailable";
  if (why === null) return { refused };
  return { refused: [...refused, "location"], ...(why === "denied" ? {} : { why }) };
}

export function openOsSettings(device: OsDevice): void {
  if (process.platform !== "darwin") return;
  void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${SETTINGS_PANE[device]}`);
}
