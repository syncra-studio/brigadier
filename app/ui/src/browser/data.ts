import { connected } from "../daemon";
import { historyGone } from "./history";
import { run, store } from "../onboarding/api";
import { getSettings, onSettings } from "../settings/api";
import { allProfiles, loadProfiles } from "./profiles";

/*
 * What the built-in browser remembers (its history, downloads and site choices, kept by Rust's `brigadier browser`),
 * and the pure helpers Settings › Browser lists them with. Main has the live downloads and the site choices'
 * copy its permission checks read (main's browser/browserDownloads.ts, permissions.ts) [D515, D516].
 */

const data = (profile: string, args: string[]) => run(["browser", "-", ...args, "--profile", profile]);

export type BrowserVisit = { id: number; url: string; title: string; atMs: number; agent: boolean };
export type HistoryFilter = "all" | "agent" | "other";

/** How many pages the history view asks for at a time. */
export const HISTORY_PAGE = 200;

/** History newest first; `after` (the last visit shown) asks for the next page. */
export async function browserHistory(profile: string, query: string, filter: HistoryFilter, after: BrowserVisit | null, limit = HISTORY_PAGE): Promise<BrowserVisit[]> {
  const page = after ? ["--before-ms", String(after.atMs), "--before-id", String(after.id)] : [];
  const reply = await data(profile, ["history", "list", "--filter", filter, "--limit", String(limit), ...page, ...(query ? ["--query", query] : [])]);
  return reply.history as BrowserVisit[];
}

export async function removeHistory(profile: string, ids: number[]): Promise<void> {
  await data(profile, ["history", "remove", ...ids.map(String)]);
  historyGone(profile, ids);
}


/** A download as listed: while running, its bytes so far and in all (0: not known), from main. */
export type DownloadRecord = { id: number; url: string; path: string; atMs: number; state: "running" | "done" | "failed" | "cancelled"; receivedBytes?: number; totalBytes?: number };

type Live = { profile: string; key: number; id: number | null; url: string; path: string; atMs: number; state: DownloadRecord["state"]; receivedBytes: number; totalBytes: number };
const live = new Map<number, Live>();
/** Goes up with every download's step, so a list that shows looks again. */
const downloadChanges = store(0);
export const useDownloadChanges = downloadChanges.use;

export async function browserDownloads(profile: string, query: string): Promise<DownloadRecord[]> {
  const found = (await data(profile, ["downloads", "list", ...(query ? ["--query", query] : [])])).downloads as DownloadRecord[];
  return found.map((row) => {
    const going = [...live.values()].find((each) => each.profile === profile && each.id === row.id);
    return going ? { ...row, receivedBytes: going.receivedBytes, totalBytes: going.totalBytes } : row;
  });
}

/** Opens a finished download with the system's app for its type. */
export async function openDownload(profile: string, id: number): Promise<void> {
  const { path } = await data(profile, ["downloads", "finished", String(id)]);
  await window.brigadierShell.downloads("open", { path });
}

/** Shows a download in Finder. */
export const revealDownload = (path: string) => window.brigadierShell.downloads("reveal", { path });

/** Forgets downloads (the files stay): `ids`, or every finished one. */
export async function removeDownloads(profile: string, ids: number[] | null): Promise<void> {
  await data(profile, ids ? ["downloads", "remove", ...ids.map(String)] : ["downloads", "clear"]);
  downloadChanges.set(downloadChanges.get() + 1);
}

/** Stops a running download; its partial file goes. */
export async function cancelDownload(profile: string, id: number): Promise<void> {
  const going = [...live.values()].find((each) => each.profile === profile && each.id === id);
  if (going) await window.brigadierShell.downloads("cancel", { key: going.key });
}

/** Main's word on a download: listed in Rust once it has a path, finished there when it ends. */
async function downloadStep(step: Omit<Live, "id">): Promise<void> {
  const known = live.get(step.key);
  const shown: Live = { ...step, id: known?.id ?? null };
  live.set(step.key, shown);
  if (shown.id === null && step.path && !known?.path) {
    shown.id = Number((await data(step.profile, ["downloads", "start", step.url, step.path, "--at-ms", String(step.atMs)])).id);
  }
  if (step.state !== "running") {
    live.delete(step.key);
    if (shown.id !== null) await data(step.profile, ["downloads", "finish", String(shown.id), step.state]);
  }
  downloadChanges.set(downloadChanges.get() + 1);
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

function bytesText(bytes: number): string {
  const unit = Math.min(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1000)), BYTE_UNITS.length - 1);
  const value = bytes / 1000 ** unit;
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** How far a running download is, for its row: "45% · 2.3 MB of 5.1 MB". */
export function downloadProgress({ receivedBytes = 0, totalBytes = 0 }: DownloadRecord): string {
  if (totalBytes <= 0) return bytesText(receivedBytes);
  return `${Math.floor((receivedBytes / totalBytes) * 100)}% · ${bytesText(receivedBytes)} of ${bytesText(totalBytes)}`;
}

/** A page's site as the lists show it: its host without "www.". */
export function siteOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long" });

function startOfDay(epochMs: number): number {
  return new Date(epochMs).setHours(0, 0, 0, 0);
}

/** A day's heading: "Today", "Yesterday", a weekday this week, else the date. */
export function dayLabel(epochMs: number, nowMs: number): string {
  const days = Math.round((startOfDay(nowMs) - startOfDay(epochMs)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return weekdayFormat.format(epochMs);
  return dayFormat.format(epochMs);
}

export type Day<T> = { key: number; label: string; items: T[] };

/** Items (newest first) in one group per calendar day, newest day first. */
export function byDay<T extends { atMs: number }>(items: readonly T[], nowMs: number): Day<T>[] {
  const days: Day<T>[] = [];
  for (const item of items) {
    const key = startOfDay(item.atMs);
    const last = days.at(-1);
    if (last?.key === key) last.items.push(item);
    else days.push({ key, label: dayLabel(item.atMs, nowMs), items: [item] });
  }
  return days;
}

export type SitePermission = "ask" | "allow" | "block";
export type BrowserSite = { origin: string; camera: SitePermission; microphone: SitePermission; location: SitePermission; askedMs: number };
type SiteDevice = "camera" | "microphone" | "location";

/** The sites that asked in `profile`: permissions are each profile's own. */
export async function browserSites(profile: string): Promise<BrowserSite[]> {
  return (await data(profile, ["sites", "list"])).sites as BrowserSite[];
}

/** Main's permission checks read a copy of the profile's choices, sent again after each change. */
async function sendSites(profile: string): Promise<BrowserSite[]> {
  const sites = await browserSites(profile);
  await window.brigadierShell.sites(profile, sites);
  return sites;
}

/** Sets what a site may use without asking: its camera, its microphone, its location. */
export async function setSite(profile: string, origin: string, choice: Partial<Record<SiteDevice, SitePermission>>): Promise<void> {
  for (const [device, permission] of Object.entries(choice)) await data(profile, ["sites", "set", origin, device, permission]);
  await sendSites(profile);
}

/** A site asked in the tab: Site settings lists it from now. */
export const siteAsked = (profile: string, origin: string, device: SiteDevice) => data(profile, ["sites", "asked", origin, device]);

/** Allow while visiting the site and Never allow are saved for the site in its profile; the others aren't. */
export function saveCardAnswer(profile: string, origin: string, asked: Partial<Record<SiteDevice, boolean>>, answer: string): Promise<void> | undefined {
  const saved = answer === "visiting" ? "allow" : answer === "never" ? "block" : null;
  if (!saved) return;
  const devices = (["camera", "microphone", "location"] as const).filter((device) => asked[device]);
  return setSite(profile, origin, Object.fromEntries(devices.map((device) => [device, saved])));
}

/** Clear browsing data's Site settings went: main forgets its copy too. */
export const sitesCleared = (profile: string) => void sendSites(profile);

/**
 * At launch, once per profile: a download the last run left going ended there (nothing resumes one), and main gets the
 * site choices. Then main's downloads come here, to be listed.
 */
export async function startBrowserData(): Promise<void> {
  // One at a time: a step waits for the one before, which may still be listing the download.
  let steps = Promise.resolve();
  window.brigadierShell.onDownload((step) => void (steps = steps.then(() => downloadStep(step as Omit<Live, "id">)).catch(console.error)));
  const configure = () => {
    const settings = getSettings();
    if (settings) void window.brigadierShell.downloads("configure", { downloadsDir: settings.browser_downloads_dir, askDownloads: settings.browser_ask_downloads });
  };
  onSettings(configure);
  configure();
  await connected();
  await loadProfiles();
  for (const { id } of allProfiles()) {
    await data(id, ["downloads", "interrupt"]);
    await sendSites(id);
  }
}
