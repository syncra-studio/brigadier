// Saved passwords on a page (the old app's browserLogins.ts). The guest preload (guestPasswords.ts) reports a page's
// sign-in fields and what the user signs in with; this judges whether a sign-in worked and fills what the app's page
// hands back. The vault is Rust's, which only the app's page reaches (app/ui/src/browser/logins.ts): a sign-in that
// worked goes there to be offered, and a fill comes from there. Nothing here keeps a password beyond its sign-in, and
// nothing logs one.
import path from "node:path";

import { app, systemPreferences, webContents, type WebContents } from "electron";

import { handleFromApp } from "./appPage";
import { profileOfStorage } from "./profiles";

export const guestPasswordsPath = path.join(__dirname, "guestPasswords.js");
export const guestPasskeyPath = path.join(__dirname, "guestPasskey.js");

/** A sign-in is judged by the next this long: a page without its password box means it worked. */
const ATTEMPT_MS = 30_000;
const NAME_STEP_MS = 5 * 60_000;

type Attempt = { site: string; username: string; password: string; at: number };
type Login = { username: string; password: string; usedMs: number };

const attempts = new Map<number, Attempt>();
const names = new Map<number, { site: string; username: string; at: number }>();
/** Whether a guest's page shows a password box now: a name-first step gets no password. */
const passwordBoxes = new Map<number, boolean>();

/** The site a password belongs to: its origin, for http and https only. */
function loginSite(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** Keeps a guest's sign-in for as long as it can still be judged. */
function keepAttempt(guest: number, attempt: Attempt): void {
  attempts.set(guest, attempt);
  setTimeout(() => {
    if (attempts.get(guest) === attempt) attempts.delete(guest);
  }, ATTEMPT_MS);
}

const tellPage = (guest: WebContents, details: object) => guest.hostWebContents?.send("brigadier:guest-login", { from: guest.id, ...details });

/** The sign-in worked: the app's page saves it, offers to, or only dates it (app/ui/src/browser/logins.ts). */
function signedIn(guest: WebContents, attempt: Attempt): void {
  if (!profileOfStorage(guest.session.storagePath ?? null)) return;
  tellPage(guest, { kind: "signed-in", site: attempt.site, username: attempt.username, password: attempt.password });
}

/** A guest's sign-ins and its fields' news, for each tab. */
export function installGuestLogins(guest: WebContents): void {
  const siteNow = () => loginSite(guest.mainFrame.url);
  let newDocument = false;
  guest.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) newDocument = true;
  });
  guest.ipc.on("brigadier:guest-login-attempt", (event, caught: { username: string; password: string }) => {
    if (event.senderFrame !== guest.mainFrame) return;
    const site = siteNow();
    if (!site || !caught.password) return;
    const step = names.get(guest.id);
    const fromStep = step?.site === site && Date.now() - step.at < NAME_STEP_MS ? step.username : "";
    keepAttempt(guest.id, { site, username: caught.username || fromStep, password: caught.password, at: Date.now() });
    newDocument = false;
  });
  guest.ipc.on("brigadier:guest-login-name", (event, username: string) => {
    const site = siteNow();
    if (event.senderFrame === guest.mainFrame && site) names.set(guest.id, { site, username, at: Date.now() });
  });
  guest.ipc.on("brigadier:guest-login-fields", (event, fields: { hasPassword: boolean; fillable: boolean }) => {
    if (event.senderFrame !== guest.mainFrame) return;
    passwordBoxes.set(guest.id, fields.hasPassword);
    const attempt = attempts.get(guest.id);
    if (attempt) {
      const inTime = Date.now() - attempt.at < ATTEMPT_MS;
      if (!inTime || !fields.hasPassword) {
        attempts.delete(guest.id);
        if (inTime) signedIn(guest, attempt);
      } else if (newDocument) {
        // The page came back with its password box: that sign-in failed.
        attempts.delete(guest.id);
      }
    }
    const site = siteNow();
    if (fields.fillable && site) tellPage(guest, { kind: "fields", site });
  });
  guest.once("destroyed", () => {
    attempts.delete(guest.id);
    names.delete(guest.id);
    passwordBoxes.delete(guest.id);
  });
}

/** The app's page says this tab isn't driven and hands over the site's logins: the last used goes into its boxes. */
function fill(id: number, logins: Login[]): void {
  const guest = webContents.fromId(id);
  if (!guest || guest.getType() !== "webview") return;
  const site = loginSite(guest.mainFrame.url);
  const login = logins.toSorted((a, b) => b.usedMs - a.usedMs)[0];
  if (!site || !login) return;
  const step = names.get(id);
  const chosen = (step?.site === site && logins.find((one) => one.username === step.username)) || login;
  guest.mainFrame.send("brigadier:guest-login-fill", { site, username: chosen.username, password: passwordBoxes.get(id) ? chosen.password : null });
}

/** Showing a password. macOS asks for Touch ID, whose prompt only the OS draws. Windows and Linux have no check here. */
async function systemCheck(reason: string): Promise<"passed" | "declined" | "unavailable"> {
  // A dev run's scripted check, never in a packaged build: a hidden instance can't put Touch ID on anyone's screen.
  const standIn = app.isPackaged ? undefined : process.env.BRIGADIER_DEV_SYSTEM_CHECK;
  if (standIn) return standIn === "pass" ? "passed" : "declined";
  if (process.platform !== "darwin") return "passed";
  if (!systemPreferences.canPromptTouchID()) return "unavailable";
  return systemPreferences.promptTouchID(reason).then(() => "passed" as const, () => "declined" as const);
}

type Args = { guest: number; logins: Login[]; reason: string };

const OPS: Record<string, (args: Args) => unknown> = {
  check: ({ reason }) => systemCheck(String(reason)),
  fill: ({ guest, logins }) => fill(Number(guest), Array.isArray(logins) ? logins : []),
};

export function installBrowserLogins(): void {
  handleFromApp("brigadier:logins", (_event, op: string, args: Args) => {
    const run = OPS[op];
    if (!run) throw new Error(`No password operation ${op}`);
    return run(args);
  });
}
