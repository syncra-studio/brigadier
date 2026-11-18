// A profile's downloads save straight to the Downloads folder, with no list or prompt [D725, D732].
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { app, type Session } from "electron";

/** Addresses "Save Image As…" asked for: those ask where to save. */
const askFor = new Set<string>();
export function askWhereToSave(url: string): void {
  askFor.add(url);
}

/** `name` in `dir`, numbered when one is there already: a download never replaces a file. */
function freePath(dir: string, name: string): string {
  const { name: stem, ext } = path.parse(name);
  let target = path.join(dir, name);
  for (let count = 1; fs.existsSync(target); count += 1) target = path.join(dir, `${stem} (${count})${ext}`);
  return target;
}

/**
 * Marks a finished file as from the web, as a browser must on a Mac: Electron doesn't, so without this Gatekeeper
 * never checks an app or script someone downloaded. Failing leaves it unmarked, which the log says.
 */
function quarantine(target: string): void {
  if (process.platform !== "darwin") return;
  const stamp = Math.floor(Date.now() / 1000).toString(16);
  execFile("/usr/bin/xattr", ["-w", "com.apple.quarantine", `0081;${stamp};Brigadier;`, target], (error) => {
    if (error) console.warn("A download couldn't be quarantined:", target, String(error));
  });
}

export function watchDownloads(session: Session): void {
  session.on("will-download", (_event, item) => {
    const target = freePath(app.getPath("downloads"), path.basename(item.getFilename()) || "download");
    if (askFor.delete(item.getURL())) item.setSaveDialogOptions({ defaultPath: target });
    else item.setSavePath(target);
    // Electron holds an interrupted item open to resume, and "done" never comes; nothing resumes one, so it ends.
    item.on("updated", (_updated, state) => state === "interrupted" && item.cancel());
    item.once("done", (_done, state) => state === "completed" && quarantine(item.getSavePath()));
  });
}
