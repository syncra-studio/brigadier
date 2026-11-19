// A page's alert, confirm and prompt while an agent holds its tab [D781]. Electron answers them with a native box on
// the window (lib/browser/api/web-contents.ts, `-run-dialog`), and the page waits on it: the agent's click would hang
// and a box would open on the user's screen. So while the debugger is on, the page's own functions answer at once:
// alert OK, confirm Cancel (OK for a click the agent sent with --confirm, which the user allowed), prompt empty. What
// they asked goes to the agent. Main frame only: a frame's boxes still show, as iframes aren't the agent's yet.
import type { WebContents } from "electron";

/** Runs in the page's own world, as the page's alert etc. are its own. The page can see it; it only ever answers. */
const ANSWER = `(() => {
  // A frame the page loads while held gets this script too; frames aren't the agent's, and their undo never runs.
  if (window !== window.top || window.__brigadierDialogs) return;
  const state = { said: [], keep: { alert: window.alert, confirm: window.confirm, prompt: window.prompt }, yes: false };
  Object.defineProperty(window, "__brigadierDialogs", { value: state, configurable: true });
  const text = (message) => String(message ?? "").slice(0, 500);
  window.alert = function alert(message) { state.said.push({ kind: "alert", message: text(message) }); };
  window.confirm = function confirm(message) { state.said.push({ kind: "confirm", message: text(message), yes: state.yes }); return state.yes; };
  window.prompt = function prompt(message) { state.said.push({ kind: "prompt", message: text(message) }); return ""; };
})()`;

/** The page's own functions back, when the agent lets go. */
const UNDO = `(() => {
  const state = window.__brigadierDialogs;
  if (!state) return;
  Object.assign(window, state.keep);
  delete window.__brigadierDialogs;
})()`;

export type Said = { kind: "alert" | "confirm" | "prompt"; message: string; yes?: boolean };

const send = (guest: WebContents, method: string, params: object) => guest.debugger.sendCommand(method, params);

/** The debugger just came on: this page and each one it loads while held answer for themselves. */
export async function answerDialogs(guest: WebContents): Promise<void> {
  await send(guest, "Page.addScriptToEvaluateOnNewDocument", { source: ANSWER }).catch(() => {});
  await send(guest, "Runtime.evaluate", { expression: ANSWER }).catch(() => {});
}

/** The agent lets go, or DevTools took the debugger: the page's own boxes come back. Needs no debugger. */
export async function showDialogs(guest: WebContents): Promise<void> {
  if (!guest.isDestroyed()) await guest.executeJavaScript(UNDO).catch(() => {});
}

/** A confirm the page asks from now on answers `yes`. */
export async function setConfirm(guest: WebContents, yes: boolean): Promise<void> {
  await send(guest, "Runtime.evaluate", { expression: `window.__brigadierDialogs && (window.__brigadierDialogs.yes = ${yes})` }).catch(() => {});
}

/** What the page asked since the last look. */
export async function dialogsSaid(guest: WebContents): Promise<Said[]> {
  const answer = await send(guest, "Runtime.evaluate", { expression: "window.__brigadierDialogs ? window.__brigadierDialogs.said.splice(0) : []", returnByValue: true }).catch(() => null) as { result?: { value?: unknown } } | null;
  const said = answer?.result?.value;
  if (!Array.isArray(said)) return [];
  return said.filter((each): each is Said => typeof each?.message === "string" && ["alert", "confirm", "prompt"].includes(each?.kind)).slice(0, 10);
}
