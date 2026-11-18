import { run } from "../onboarding/api";
import { ago } from "../panel/words";
import { openTab } from "../shell/tab-store";
import { allProfiles, type BrowserProfile, createProfile, loadProfiles, nextHue, switchProfile } from "./profiles";

/*
 * Settings › Import Browser Data: sign-ins only, cookies and site storage [D725, D729]. Rust's commands
 * (crates/cli/src/browser/imports.rs), and the pure words and choices the page shows for each browser. A source's
 * cookies pass through here once, on their way to main.
 */

export type ImportState = "ready" | "running" | "needsFullDiskAccess" | "needsKeychainAccess" | "noKeychainKey" | "unavailable";
export type ImportFailure = "running" | "needsFullDiskAccess" | "needsKeychainAccess" | "noKeychainKey" | "gone" | "readFailed";
export type ImportProgress = { type: "reading" } | { type: "cookies"; done: number; total: number };

/** A source profile's last import: when, and its name; a browser's row has all its profiles' names. */
export type ImportedRecord = { atMs: number; profiles: string[] };

/** A browser as Rust lists it. */
export type ListedSource = {
  key: string;
  name: string;
  family: "chromium" | "safari";
  appPath: string;
  state: ImportState;
  /** Its profiles with something to bring, the default first; `cookies` null when they couldn't be counted. */
  profiles: { id: string; name: string; cookies: number | null; isDefault: boolean }[];
  /** Its profiles with nothing to bring, by name: they get no profile here. */
  emptyProfiles: string[];
  /** Whether its cookies may be read: not where "Chromium Safe Storage" locks them. */
  signIns: boolean;
  /** Its source profiles' last imports summed up; null before any. */
  record: ImportedRecord | null;
  /** Where each source profile (any browser's) went last, by its id. */
  imports: Partial<Record<string, { into: string; atMs: number }>>;
  /** No import has run yet, so the page shows its one notice about agents. */
  firstImport: boolean;
};

const imports = (args: string[]) => run(["browser", "-", "imports", ...args]);
const shell = (op: string, args: Record<string, unknown> = {}) => window.brigadierShell.browserImport(op, args);

/** A browser's app icon, from main; null: a globe in a tile. */
export const iconOf = (source: ListedSource): Promise<string | null> => shell("icon", { path: source.appPath }) as Promise<string | null>;

/** The browsers as last listed, and when: the page shows them at once when it opens again. */
export type ListedSources = { sources: ListedSource[]; atMs: number };
let listed: ListedSources | null = null;

/** The installed browsers in the page's order, each with where it stands. */
export async function importSources(): Promise<ListedSource[]> {
  const { sources } = (await imports(["sources"])) as { sources: ListedSource[] };
  listed = { sources, atMs: Date.now() };
  return sources;
}

export const lastImportSources = (): ListedSources | null => listed;

/** The browser each profile last had an import from, by profile. */
export function importOrigins(): Promise<Partial<Record<string, string>>> {
  return imports(["origins"]).then((reply) => reply.origins as Record<string, string>, () => ({}));
}

export type ImportedOutcome =
  | { type: "done"; record: ImportedRecord; siteStorage: "copied" | "nextStart" | null }
  | { type: "failed"; reason: ImportFailure; message: string };

/** One ticked profile of the other browser, and where it goes: "new", or the profile it replaces. */
export type ImportChoice = { id: string; name: string; into: string };

export type ProfileImportResult = {
  choice: ImportChoice;
  /** The Brigadier profile it went into. */
  profile: BrowserProfile;
  replaced: boolean;
  outcome: ImportedOutcome;
};

/** A new profile's name: the source's own, with the browser's where it wouldn't say which it is. */
export function importedName(browser: string, name: string, taken: readonly string[]): string {
  const plain = !/^(default|default-release|person \d+)$/i.test(name) && !taken.includes(name);
  return plain ? name : `${browser}: ${name}`;
}

const COOKIES_AT_ONCE = 50;

/**
 * Imports one profile's sign-ins. It is read first, so a browser that can't be read makes no profile; then a new
 * Brigadier profile is made for it if asked, Rust puts the site storage in, and main sets the cookies, a few at a time.
 */
export async function importProfile(source: Pick<ListedSource, "key" | "name">, choice: ImportChoice, onProgress: (progress: ImportProgress) => void): Promise<ProfileImportResult> {
  const replaced = choice.into !== "new";
  await loadProfiles();
  const profiles = allProfiles();
  const existing = profiles.find((profile) => profile.id === choice.into);
  onProgress({ type: "reading" });
  const read = (await imports(["read", source.key, choice.id])) as { type: "ready"; cookies: unknown[]; record: ImportedRecord } | Extract<ImportedOutcome, { type: "failed" }>;
  if (read.type === "failed") {
    const profile = existing ?? { id: "", name: choice.name, hue: nextHue(profiles) };
    return { choice, profile, replaced, outcome: read };
  }
  const name = importedName(source.name, choice.name, profiles.map((profile) => profile.name));
  const target = existing?.id ?? (await createProfile(name, nextHue(profiles)));
  // Site storage goes in before the session opens, which holds its folders from then on.
  const opened = (await shell("opened", { profile: target })) === true;
  const placed = (await run(["browser", "-", "imports", "place", source.key, choice.id, JSON.stringify(read.record), ...(opened ? ["--open"] : []), "--profile", target])) as Extract<ImportedOutcome, { type: "done" }>;
  if (replaced) await shell("clear", { profile: target, storageCopied: placed.siteStorage === "copied" });
  const total = read.cookies.length;
  onProgress({ type: "cookies", done: 0, total });
  for (let at = 0; at < total; at += COOKIES_AT_ONCE) {
    await shell("cookies", { profile: target, cookies: read.cookies.slice(at, at + COOKIES_AT_ONCE) });
    onProgress({ type: "cookies", done: Math.min(at + COOKIES_AT_ONCE, total), total });
  }
  await shell("settled", { profile: target, replaced });
  const profile = allProfiles().find((each) => each.id === target) ?? { id: target, name, hue: nextHue(profiles) };
  return { choice, profile, replaced, outcome: placed };
}

/** Quits and opens Brigadier again, so site storage an import left for the next start goes in. */
export const restartApp = (): void => void shell("restart");

/** The session most lately active, where a profile opens from Settings. */
export const latestSession = (rows: readonly { id: string; updated: number; archived?: number | null }[] | undefined): string | null =>
  (rows ?? []).filter((row) => !row.archived).toSorted((a, b) => b.updated - a.updated)[0]?.id ?? null;

/** Puts `session` on `profile`, in a New tab, in front. */
export function openProfile(session: string, profile: string): void {
  openTab(session, "new");
  void switchProfile(session, profile);
  window.location.hash = `#thread/${encodeURIComponent(session)}`;
}

/** Opens System Settings at Full Disk Access. */
export const openFullDiskAccess = (): void => void shell("access");

const number = new Intl.NumberFormat();

/** "1 cookie", "2,790 cookies". */
export const counted = (n: number, one: string, many: string): string => `${number.format(n)} ${n === 1 ? one : many}`;

export type RowTone = "ready" | "attention" | "idle";
/** What a row's button does: import, look again, ask for Full Disk Access, or nothing. */
export type RowAction = "import" | "recheck" | "grant" | "none";
export type RowView = { status: string; tone: RowTone; details: string[]; action: RowAction; label: string | null };

/** The cookies a browser's profiles keep in all; null when one couldn't be counted. */
export function totalCookies(source: ListedSource): number | null {
  let total = 0;
  for (const profile of source.profiles) {
    if (profile.cookies === null) return null;
    total += profile.cookies;
  }
  return total;
}

/** A browser's row: its status, details and its one button. */
export function rowView(source: ListedSource): RowView {
  switch (source.state) {
    case "running":
      return { status: `Running · quit ${source.name} to import`, tone: "attention", details: [], action: "recheck", label: "Recheck" };
    case "needsFullDiskAccess":
      return { status: "Needs Full Disk Access", tone: "attention", details: [], action: "grant", label: "Grant access…" };
    case "noKeychainKey":
      return { status: "No encryption key in Keychain", tone: "idle", details: [], action: "recheck", label: "Recheck" };
    case "unavailable":
      return { status: "Unavailable", tone: "idle", details: [], action: "none", label: null };
    case "needsKeychainAccess":
      return { status: "Needs Keychain access", tone: "attention", details: [], action: "import", label: "Import…" };
    case "ready":
      break;
  }
  const profiles = source.profiles.length;
  const total = totalCookies(source);
  const profileCount = counted(profiles, "profile", "profiles");
  if (profiles === 0) return { status: "Nothing to bring", tone: "idle", details: [], action: "none", label: "Import…" };
  const details = source.record ? [`${source.record.profiles.join(", ")} imported`] : [profileCount, ...(total === null ? [] : [counted(total, "cookie", "cookies")])];
  return { status: "Ready", tone: "ready", details, action: "import", label: "Import…" };
}

/** The badge after a browser's name once something was imported from it. */
export const importedBadge = (record: ImportedRecord, nowMs: number): string => `Imported ${ago(record.atMs, nowMs)}`;

/** Failures that open a dialog to put right (the rest show in the results). */
export const opensDialog = (reason: ImportFailure): boolean => reason === "running" || reason === "needsFullDiskAccess" || reason === "needsKeychainAccess" || reason === "noKeychainKey";

/** Whether trying again can help. */
export const retryable = (reason: ImportFailure): boolean => reason !== "gone";

/** Why a browser can't be imported from, in plain words. */
export function reasonText(reason: ImportFailure, name: string): string {
  switch (reason) {
    case "running":
      return `Quit ${name} first, so its cookies can be read.`;
    case "needsFullDiskAccess":
      return "Give Brigadier Full Disk Access in System Settings › Privacy & Security, then try again.";
    case "needsKeychainAccess":
      return `Brigadier needs Keychain access to read ${name}'s cookie encryption key. Choose Allow when macOS asks, then try again.`;
    case "noKeychainKey":
      return `No matching encryption key was found in your Keychain. Open ${name} and sign in to a site, then try again.`;
    case "gone":
      return "That browser or profile is no longer here.";
    case "readFailed":
      return `${name}'s cookies couldn't be read.`;
  }
}

/** The import's progress line. */
export function progressText(progress: ImportProgress | null): string {
  if (!progress || progress.type === "reading") return "Reading and decrypting cookies. macOS may ask for Keychain access.";
  return `Adding cookies… ${number.format(progress.done)} of ${number.format(progress.total)}`;
}
