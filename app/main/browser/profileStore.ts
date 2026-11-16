// A profile's engine data: its Chromium session, cleared and removed here. The list, and which profile each
// session and tab is on, are Rust's (crates/cli/src/browser), which main only reads to guard deleting.
import fs from "node:fs";
import path from "node:path";

import { app, BrowserWindow, session, webContents } from "electron";

import { handleFromApp } from "./appPage";
import { clearEngineData, type EngineClear } from "./browserClearData";
import { profileFolderName, profilePartition, refusalToRemove, type SavedProfiles } from "./profiles";

// main.ts puts Chromium's data at <data>/chromium; Rust keeps the browser's beside it, at <data>/browser.
const listFile = () => path.join(app.getPath("userData"), "..", "browser", "browser-profiles.json");
const removedFile = () => path.join(app.getPath("userData"), "browser-profiles-removed.json");

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  const next = `${file}.next`;
  fs.writeFileSync(next, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(next, file);
}

/** Profiles on their way out: nothing new opens on one (the partition is refused). */
const deleting = new Set<string>();
export const isDeleting = (profileId: string): boolean => deleting.has(profileId);

/**
 * Empties a profile's session: sign-ins, site data and caches. Its folder can't go while Chromium has the session
 * open, and Electron has no way to close one, so a deleted profile's folder goes at the next launch.
 */
async function clearProfile(profileId: string): Promise<void> {
  const profileSession = session.fromPartition(profilePartition(profileId));
  await profileSession.clearData();
  await profileSession.clearAuthCache();
  await profileSession.cookies.flushStore();
  profileSession.flushStorageData();
}

/** The windows a page opened keep their opener's session, and the page's move to another profile can't take them. */
function closePopupsOf(profileId: string): void {
  const profileSession = session.fromPartition(profilePartition(profileId));
  for (const contents of webContents.getAllWebContents()) {
    if (contents.session === profileSession) BrowserWindow.fromWebContents(contents)?.destroy();
  }
}

async function removeProfile(profileId: string): Promise<void> {
  const refusal = refusalToRemove(profileId, readJson<SavedProfiles>(listFile()));
  if (refusal) throw new Error(refusal);
  deleting.add(profileId);
  const removed = readJson<string[]>(removedFile()) ?? [];
  // Written first: a crash during the clear still ends with the folder gone.
  writeJson(removedFile(), [...new Set([...removed, profileId])]);
  closePopupsOf(profileId);
  // shortcut: no downloads to cancel until the downloads section lands (browserDownloads' cancelDownloadsOf).
  await clearProfile(profileId);
}

/** Sites with cookies, by domain: what the profile is signed in to at most. */
async function signInCount(profileId: string): Promise<number> {
  const cookies = await session.fromPartition(profilePartition(profileId)).cookies.get({});
  return new Set(cookies.map((cookie) => (cookie.domain ?? "").replace(/^\./, ""))).size;
}

/** Before any session opens: deleted profiles' folders, named by id only, so nothing else can be reached. */
function removeDeletedFolders(): void {
  const removed = readJson<string[]>(removedFile());
  if (!removed) return;
  for (const profileId of removed) {
    fs.rmSync(path.join(app.getPath("userData"), "Partitions", profileFolderName(profileId)), { recursive: true, force: true });
  }
  fs.rmSync(removedFile(), { force: true });
}

function refuseIfDeleting(profileId: string): void {
  if (deleting.has(profileId)) throw new Error("This profile is being deleted");
}

type Args = { profile: string; clear: EngineClear };

const OPS: Record<string, (args: Args) => unknown> = {
  remove: ({ profile }) => removeProfile(profile),
  counts: async ({ profile }) => {
    refuseIfDeleting(profile);
    return { signIns: await signInCount(profile) };
  },
  clear: ({ profile, clear }) => {
    refuseIfDeleting(profile);
    return clearEngineData(profile, clear);
  },
};

export function installProfileStore(): void {
  removeDeletedFolders();
  handleFromApp("brigadier:profiles", (_event, op: string, args: Args) => {
    const run = OPS[op];
    if (!run) throw new Error(`No profile operation ${op}`);
    return run(args);
  });
}
