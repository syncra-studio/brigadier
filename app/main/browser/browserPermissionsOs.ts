// The system's side of a site permission, after the person's yes to Brigadier's card: its own question, then its
// answer. Electron doesn't ask for location: Chromium only starts position updates, so Brigadier must ask macOS itself
// and answer the page once macOS has.
import { shell, systemPreferences } from "electron";

import type { SiteAsk } from "./profiles";

export type OsDevice = "camera" | "microphone" | "location";

const SETTINGS_PANE: Record<OsDevice, string> = {
  camera: "Privacy_Camera",
  microphone: "Privacy_Microphone",
  location: "Privacy_LocationServices",
};

/** Asks the system for what the person just allowed; what it refuses, has off, or leaves unanswered comes back by name. */
export async function refusedByOs(asked: SiteAsk): Promise<OsDevice[]> {
  if (process.platform !== "darwin") return [];
  const refused: OsDevice[] = [];
  for (const device of ["camera", "microphone"] as const) {
    if (asked[device] && !(await systemPreferences.askForMediaAccess(device))) refused.push(device);
  }
  // shortcut: no native module to ask macOS for location yet, so it counts as refused; port the old native.ts's locationStatus and locationAsk when a site needs it.
  if (asked.location) refused.push("location");
  return refused;
}

export function openOsSettings(device: OsDevice): void {
  if (process.platform !== "darwin") return;
  void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${SETTINGS_PANE[device]}`);
}
