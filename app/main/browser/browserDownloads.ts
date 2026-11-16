// A profile's downloads: where each file goes, its progress and a cancel. The list is Rust's: each step goes to the
// app's page, which records it (app/ui/src/browser/data.ts); bytes so far are only here, since nothing resumes a
// download after a restart.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { app, shell, type DownloadItem, type Session } from "electron";

import { handleFromApp, toAppPages } from "./appPage";

type DownloadState = "running" | "done" | "failed" | "cancelled";

/** The app's settings main acts on itself; the page keeps them current (app/ui/src/browser/data.ts). */
let options = { downloadsDir: "", askDownloads: false };

/** Addresses "Save Image As…" asked for: those ask where to save, whatever the setting. */
const askFor = new Set<string>();
export function askWhereToSave(url: string): void {
  askFor.add(url);
}

let nextKey = 1;
const running = new Map<number, { profileId: string; item: DownloadItem }>();

/** `name` in `dir`, numbered when one is there already: a download never replaces a file. */
function freePath(dir: string, name: string): string {
  const { name: stem, ext } = path.parse(name);
  let target = path.join(dir, name);
  for (let count = 1; fs.existsSync(target); count += 1) target = path.join(dir, `${stem} (${count})${ext}`);
  return target;
}

function chosenDir(): string {
  const dir = options.downloadsDir;
  const usable = path.isAbsolute(dir) && fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true;
  return usable ? dir : app.getPath("downloads");
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

function follow(profileId: string, item: DownloadItem): void {
  const key = nextKey++;
  const atMs = Date.now();
  running.set(key, { profileId, item });
  // Asked where to save, there's no path to list until the user has picked one.
  const tell = (state: DownloadState) => toAppPages("brigadier:browser-download", {
    profile: profileId, key, url: item.getURL(), path: item.getSavePath(), atMs, state,
    receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(),
  });
  tell("running");
  let broke = false;
  item.on("updated", (_event, state) => {
    // Electron holds an interrupted item open to resume, and "done" never comes. Nothing here resumes one, so it ends as failed.
    if (state === "interrupted") {
      broke = true;
      item.cancel();
      return;
    }
    tell("running");
  });
  item.once("done", (_event, state) => {
    running.delete(key);
    const final: DownloadState = state === "completed" ? "done" : state === "cancelled" && !broke ? "cancelled" : "failed";
    if (final === "done") quarantine(item.getSavePath());
    tell(final);
  });
}

/** Takes the session's downloads into the chosen folder and the profile's list. */
export function watchDownloads(session: Session, profileId: string): void {
  session.on("will-download", (_event, item) => {
    const asked = options.askDownloads || askFor.delete(item.getURL());
    const target = freePath(chosenDir(), path.basename(item.getFilename()) || "download");
    if (asked) item.setSaveDialogOptions({ defaultPath: target });
    else item.setSavePath(target);
    follow(profileId, item);
  });
}

/** The profile is being deleted: what it still has running stops. */
export function cancelDownloadsOf(profileId: string): void {
  for (const each of [...running.values()]) {
    if (each.profileId === profileId) each.item.cancel();
  }
}

type Args = { downloadsDir?: string; askDownloads?: boolean; key?: number; path?: string };

const OPS: Record<string, (args: Args) => unknown> = {
  configure: ({ downloadsDir, askDownloads }) => (options = { downloadsDir: downloadsDir ?? "", askDownloads: askDownloads === true }),
  cancel: ({ key }) => running.get(Number(key))?.item.cancel(),
  // Only a path Rust lists as a finished download comes here (data.ts's openDownload).
  open: async ({ path: file }) => {
    if (!file || !fs.existsSync(file)) throw new Error("That download isn't there any more");
    const failed = await shell.openPath(file);
    if (failed) throw new Error(failed);
  },
  reveal: ({ path: file }) => {
    if (!file || !fs.existsSync(file)) throw new Error("That download isn't there any more");
    shell.showItemInFolder(file);
  },
};

export function installDownloads(): void {
  handleFromApp("brigadier:downloads", (_event, op: string, args: Args) => {
    const run = OPS[op];
    if (!run) throw new Error(`No downloads operation ${op}`);
    return run(args ?? {});
  });
}
