// A page's alert, confirm and prompt while an agent holds its tab [D781]. Electron answers them with a native box on
// the window (lib/browser/api/web-contents.ts, `-run-dialog`), and the page waits on it: the agent's click would hang
// and a box would open on the user's screen. So while the debugger is on, the page's own functions answer at once:
// alert OK, confirm Cancel (OK for a click the agent sent with --confirm, which the user allowed), prompt empty. What
// they asked goes to the agent. Main frame only; a box they miss (a frame's, or a function the page kept before) the
// debugger answers the same way.
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

/** Boxes the page's own functions didn't answer (one it kept before we came, a frame's), by guest, and whose confirm says OK. */
const caught = new Map<number, Said[]>();
const confirming = new Set<number>();

/** While held, a box the override missed is answered through the debugger as the override would, or it holds the page. */
export function watchDialogs(guest: WebContents): void {
  guest.debugger.on("message", (_event, method, params: { type?: string; message?: string }) => {
    if (method !== "Page.javascriptDialogOpening" || !["alert", "confirm", "prompt"].includes(params.type ?? "")) return;
    const kind = params.type as Said["kind"];
    const yes = kind !== "confirm" || confirming.has(guest.id);
    void send(guest, "Page.handleJavaScriptDialog", { accept: yes, promptText: "" }).catch(() => {});
    // Electron's own box for it opens too, right after this: its `-cancel-dialogs` (lib/browser/api/web-contents.ts)
    // closes it unanswered once it's there.
    setImmediate(() => guest.isDestroyed() || guest.emit("-cancel-dialogs"));
    const said: Said = { kind, message: String(params.message ?? "").slice(0, 500), ...(kind === "confirm" ? { yes } : {}) };
    caught.set(guest.id, [...(caught.get(guest.id) ?? []), said]);
  });
  guest.once("destroyed", () => caught.delete(guest.id));
}

/** The debugger just came on: this page and each one it loads while held answer for themselves. */
export async function answerDialogs(guest: WebContents): Promise<void> {
  await send(guest, "Page.enable", {}).catch(() => {});
  await send(guest, "Page.addScriptToEvaluateOnNewDocument", { source: ANSWER }).catch(() => {});
  await send(guest, "Runtime.evaluate", { expression: ANSWER }).catch(() => {});
}

/** The agent lets go, or DevTools took the debugger: the page's own boxes come back. Needs no debugger. */
export async function showDialogs(guest: WebContents): Promise<void> {
  if (!guest.isDestroyed()) await guest.executeJavaScript(UNDO).catch(() => {});
}

/** A confirm the page asks from now on answers `yes`. */
export async function setConfirm(guest: WebContents, yes: boolean): Promise<void> {
  if (yes) confirming.add(guest.id);
  else confirming.delete(guest.id);
  await send(guest, "Runtime.evaluate", { expression: `window.__brigadierDialogs && (window.__brigadierDialogs.yes = ${yes})` }).catch(() => {});
}

/** How many boxes the page asked in since the last look, left for it. */
export async function dialogsCount(guest: WebContents): Promise<number> {
  const answer = await send(guest, "Runtime.evaluate", { expression: "window.__brigadierDialogs?.said.length ?? 0", returnByValue: true }).catch(() => null) as { result?: { value?: unknown } } | null;
  return Number(answer?.result?.value ?? 0) + (caught.get(guest.id)?.length ?? 0);
}

/** What the page asked since the last look. */
export async function dialogsSaid(guest: WebContents): Promise<Said[]> {
  const answer = await send(guest, "Runtime.evaluate", { expression: "window.__brigadierDialogs ? window.__brigadierDialogs.said.splice(0) : []", returnByValue: true }).catch(() => null) as { result?: { value?: unknown } } | null;
  const value = answer?.result?.value;
  const said = (Array.isArray(value) ? value : []).filter((each): each is Said => typeof each?.message === "string" && ["alert", "confirm", "prompt"].includes(each?.kind));
  const missed = caught.get(guest.id) ?? [];
  caught.delete(guest.id);
  return [...said, ...missed].slice(0, 10);
}
