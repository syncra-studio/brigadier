// What an agent's verbs do to a guest (crates/cli/src/browser.rs, app/ui/src/browser/agent.ts). Agents only ever have
// verbs: nothing here takes protocol methods, so the app's page can ask for a click, never for a CDP call. Only the
// eval verb takes code, which main runs as the page's own script (browserDevtoolsEval.ts). Pages, network and console come from Electron's own events, with no debugger on the tab;
// webContents.debugger is attached only while an agent acts, for trusted input, and goes as soon as the user takes
// the tab. It is in-process, so no port and no automation switch.
import { webContents, type WebContents } from "electron";

import { handleFromApp } from "./appPage";
import { activityOf, forgetActivity, shownTitle, shownUrl, watchActivity, watchNetwork } from "./browserAgentActivity";
import { forgetSecrets, pictureForAgent, runScript, runSeeingHandlers, sweptAndScrubbed } from "./browserAgentSecrets";
import { evalOnPage } from "./browserDevtoolsEval";
import { answerDialogs, dialogsSaid, setConfirm, showDialogs } from "./browserAgentDialogs";
import { stopOf } from "./browserSignIn";
import { stopForAddress } from "./browserSignInRules";
import { openerTab } from "./guestPopups";

export { watchNetwork };

type AgentEvent = "devtools-opened" | "devtools-closed" | "detached" | "used";
type Held = {
  /** Calls run in order: a let-go waits for a click under way, so no button stays pressed. */
  queue: Promise<unknown>;
};
const held = new Map<number, Held>();

/** Pages an agent's own input is going into now. */
const sending = new Set<number>();

/** Tabs with DevTools open. `isDevToolsOpened` answers false for DevTools in a view of ours (browserDevtools.ts). */
const opened = new Set<number>();
export const devToolsOpen = (guest: WebContents): boolean => opened.has(guest.id) || guest.isDevToolsOpened();

/** The guest of a call from `sender`, which must be the page hosting it, or the tab whose window it is. */
function guestFor(sender: WebContents, id: unknown): WebContents {
  const guest = typeof id === "number" ? webContents.fromId(id) : undefined;
  const tab = guest && (openerTab(guest) ?? guest);
  if (!guest || !tab || guest.isDestroyed() || tab.isDestroyed() || tab.getType() !== "webview" || tab.hostWebContents !== sender) throw new Error("That page is gone.");
  return guest;
}

/** Tells the page hosting the tab; of a window, the tab it's of. */
function tellHost(guest: WebContents, event: AgentEvent): void {
  const tab = openerTab(guest) ?? guest;
  if (!tab.isDestroyed()) tab.hostWebContents?.send("brigadier:agent-event", { from: tab.id, event });
}

async function attach(guest: WebContents): Promise<void> {
  if (held.has(guest.id)) return;
  if (devToolsOpen(guest)) throw new Error("devtools_open");
  guest.debugger.attach("1.3");
  held.set(guest.id, { queue: Promise.resolve() });
  // A page behind its tab takes input and keeps its timers, and the user's focus going back blurs nothing. The same
  // use as Orca's enablePageFocusEmulation (MIT, stablyai/orca). What this changes goes with the session.
  await guest.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await answerDialogs(guest);
}

/** Lets go of the tab, after what is under way. Ending the session clears any input state and the emulation. */
async function release(guest: WebContents): Promise<void> {
  const hold = held.get(guest.id);
  if (!hold) return;
  held.delete(guest.id);
  await hold.queue.catch(() => {});
  if (guest.isDestroyed() || !guest.debugger.isAttached()) return;
  await showDialogs(guest);
  guest.debugger.detach();
}

/**
 * Runs `input` in the tab's order; an answer the user's take-over overtook is `paused`. It answers what the page asked
 * in a box meanwhile; `confirm` answers OK to a confirm box, for this input only.
 */
async function acting(guest: WebContents, input: (send: (method: string, params: object) => Promise<unknown>) => Promise<void>, confirm = false): Promise<unknown> {
  if (devToolsOpen(guest)) return { paused: "devtools" };
  await attach(guest);
  const hold = held.get(guest.id);
  if (!hold) return { paused: "user" };
  const run = hold.queue.then(async () => {
    const stillHeld = () => held.get(guest.id) === hold;
    if (!stillHeld()) return { paused: devToolsOpen(guest) ? "devtools" : "user" };
    if (confirm) await setConfirm(guest, true);
    sending.add(guest.id);
    try {
      await input((method, params) => guest.debugger.sendCommand(method, params));
    } finally {
      sending.delete(guest.id);
      if (confirm) await setConfirm(guest, false);
    }
    // A box's words may quote a field's value: password values come out as any page text's do.
    return sweptAndScrubbed(guest, async () => ({ done: true, dialogs: await dialogsSaid(guest) }));
  });
  hold.queue = run.catch(() => {});
  try {
    return await run;
  } catch (error) {
    if (guest.isDestroyed()) throw new Error("The tab closed.", { cause: error });
    if (devToolsOpen(guest) || !guest.debugger.isAttached()) return { paused: devToolsOpen(guest) ? "devtools" : "user" };
    throw error;
  }
}

/** Whether the page's focused element, through open shadow roots, is a password field or one that looks like it. */
const FOCUSED_SECRET = `(() => {
  let at = document.activeElement;
  while (at?.shadowRoot?.activeElement) at = at.shadowRoot.activeElement;
  if (!at || !at.getAttribute) return false;
  return at.type === "password" || /\\b(current|new)-password\\b/i.test(at.getAttribute("autocomplete") || "") || (getComputedStyle(at).webkitTextSecurity || "none") !== "none";
})()`;

const mouse = (type: string, x: number, y: number, buttons: number) => ({
  type,
  x,
  y,
  buttons,
  button: type === "mouseMoved" ? "none" : "left",
  clickCount: type === "mouseMoved" ? 0 : 1,
});

/** The keys an agent's press names (crates/cli/src/browser/hub/asks.rs), as Electron's key codes. */
const KEY_CODES: Record<string, string> = {
  Enter: "Return", Escape: "Escape", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Space: "Space",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
};
const MODIFIERS = new Set(["shift", "control", "alt", "meta"]);

/** A key as widget events: down, its character where it types one, up. Only a named key or one character. */
function keyEvents(key: string, modifiers: string[]): Electron.KeyboardInputEvent[] {
  const named = KEY_CODES[key] ?? (/^F([1-9]|1[0-2])$/.test(key) || [...key].length === 1 ? key : null);
  if (!named || !Array.isArray(modifiers) || !modifiers.every((each) => MODIFIERS.has(each))) throw new Error("Unknown key");
  const mods = modifiers as Electron.KeyboardInputEvent["modifiers"];
  const typing = !modifiers.includes("meta") && !modifiers.includes("control") && ([...key].length === 1 || key === "Enter" || key === "Space");
  const char = key === "Space" ? " " : named;
  return [
    { type: "keyDown", keyCode: named, modifiers: mods },
    ...(typing ? [{ type: "char" as const, keyCode: char, modifiers: mods }] : []),
    { type: "keyUp", keyCode: named, modifiers: mods },
  ];
}

/** DevTools ends a debugger session (electron.d.ts, Debugger's `detach`), so opening it counts as take-over. */
function watchDevTools(guest: WebContents): void {
  guest.on("devtools-opened", () => {
    opened.add(guest.id);
    tellHost(guest, "devtools-opened");
    void release(guest);
  });
  guest.on("devtools-closed", () => devToolsEnded(guest));
  guest.debugger.on("detach", () => {
    // Ours forgets the hold first, so a hold still here was ended from outside: nothing resumes by itself.
    if (!held.delete(guest.id) || guest.isDestroyed()) return;
    void showDialogs(guest);
    // A window that closes ends its debugger as one ended from outside does, so only its tab's own says so.
    if (devToolsOpen(guest) || !openerTab(guest)) tellHost(guest, devToolsOpen(guest) ? "devtools-opened" : "detached");
  });
}

/**
 * For whatever opens DevTools (section 9): pause first and release held input, then open. The in-flight call answers
 * "Paused: DevTools open".
 */
export async function beforeDevTools(guest: WebContents): Promise<void> {
  if (!held.has(guest.id)) return;
  tellHost(guest, "devtools-opened");
  await release(guest);
}

/** DevTools went from this tab. Closing DevTools held in a view of ours fires no `devtools-closed`, so its view's end says so. */
export function devToolsEnded(guest: WebContents): void {
  opened.delete(guest.id);
  if (!guest.isDestroyed()) tellHost(guest, "devtools-closed");
}

/**
 * The user's click or key in a window a tab's page opened takes the tab over: no shield lies over it, as one does over
 * a tab's page. Input while the agent's goes in is taken for its own: they reach here alike.
 * shortcut: a click in a cross-site frame of the window may not be heard, only a key there; watch the frames' input if that matters.
 */
export function watchUserInput(window: WebContents): void {
  const used = () => {
    if (!sending.has(window.id)) tellHost(window, "used");
  };
  window.on("before-mouse-event", (_event, mouse) => {
    if (mouse.type === "mouseDown") used();
  });
  window.on("before-input-event", (_event, input) => {
    // A modifier alone may be ⌘Tab on its way to another app.
    if (input.type === "keyDown" && !["Meta", "Shift", "Control", "Alt"].includes(input.key)) used();
  });
}

/** Every tab's guest, from when it is made. */
export function watchGuest(guest: WebContents): void {
  const id = guest.id;
  watchActivity(guest);
  watchDevTools(guest);
  guest.once("destroyed", () => {
    held.delete(id);
    sending.delete(id);
    // A window that closed with its DevTools open says so, or its tab would wait for them.
    if (opened.delete(id) && openerTab(guest)) tellHost(guest, "devtools-closed");
    forgetActivity(id);
    forgetSecrets(id);
  });
}

type Call =
  | { call: "shown"; guest?: number; url: string; title: string; query: boolean }
  | { call: "script"; guest: number; op: Record<string, unknown> }
  | { call: "attach"; guest: number }
  | { call: "release"; guest: number }
  | { call: "click"; guest: number; x: number; y: number; confirm?: boolean }
  | { call: "enter"; guest: number }
  | { call: "key"; guest: number; key: string; modifiers: string[] }
  | { call: "hover"; guest: number; x: number; y: number }
  | { call: "scroll"; guest: number; x: number; y: number; deltaY: number }
  | { call: "wheel"; guest: number; x: number; y: number; deltaX: number; deltaY: number }
  | { call: "events"; guest: number; since: number; kinds: string[] }
  | { call: "capture"; guest: number }
  | { call: "signInStop"; guest: number };

/** The script's kinds that tell what can be clicked. */
const SEES_HANDLERS = new Set<unknown>(["read", "click", "place", "hover"]);

export function installBrowserAgent(): void {
  handleFromApp("brigadier:agent", async (event, call: Call) => {
    // A page's address and title for its agent. An ordinary page's query stays, as the agent may have to open it again;
    // `query` hides a popup's and a paused tab's, and a sign-in page's is hidden here.
    if (call.call === "shown") {
      const page = call.guest === undefined ? undefined : webContents.fromId(call.guest);
      const query = call.query || stopForAddress(call.url) !== null || (page !== undefined && (await stopOf(page)) !== null);
      return { url: shownUrl(call.url, query), title: shownTitle(call.title, call.url) };
    }
    const guest = guestFor(event.sender, call.guest);
    switch (call.call) {
      case "script":
        // A sweep's answer holds field values, and stays in this process.
        if (call.op.kind === "sweep") throw new Error("Unknown agent call");
        // The one way code from outside reaches a page: the user read it on a card and said yes (agentBrowser.ts).
        if (call.op.kind === "eval") return evalOnPage(guest, String(call.op.script));
        return sweptAndScrubbed(guest, () => (SEES_HANDLERS.has(call.op.kind) ? runSeeingHandlers : runScript)(guest, call.op));
      case "attach":
        return attach(guest);
      case "release":
        // Its windows go with it.
        for (const id of held.keys()) {
          const window = webContents.fromId(id);
          if (window && openerTab(window) === guest) void release(window);
        }
        return release(guest);
      case "click":
        return acting(guest, async (send) => {
          await send("Input.dispatchMouseEvent", mouse("mouseMoved", call.x, call.y, 0));
          await send("Input.dispatchMouseEvent", mouse("mousePressed", call.x, call.y, 1));
          await send("Input.dispatchMouseEvent", mouse("mouseReleased", call.x, call.y, 0));
        }, call.confirm === true);
      case "enter":
        // Widget events, not the debugger's keys, which follow the window's focus (as Orca found, its #20595).
        return acting(guest, async () => {
          guest.sendInputEvent({ type: "keyDown", keyCode: "Return" });
          guest.sendInputEvent({ type: "char", keyCode: "Return" });
          guest.sendInputEvent({ type: "keyUp", keyCode: "Return" });
        });
      case "key": {
        const events = keyEvents(call.key, call.modifiers);
        // Widget events, as Enter's. The page gets its focus first, so a focus handler that makes the field a
        // password field has run, and then the last look: keys never go into one [D518 D725].
        return acting(guest, async (send) => {
          // A window's would come to the front of the user's screen; its page has the emulated focus already.
          if (!openerTab(guest)) guest.focus();
          const looked = await send("Runtime.evaluate", { expression: FOCUSED_SECRET, returnByValue: true }) as { result?: { value?: unknown } };
          if (looked.result?.value !== false) throw new Error("That is a password field, and only the user fills those in, so no key was sent. Ask them to sign in in this tab, and go on when they say so.");
          for (const each of events) guest.sendInputEvent(each);
        });
      }
      case "hover":
        return acting(guest, async (send) => {
          await send("Input.dispatchMouseEvent", mouse("mouseMoved", call.x, call.y, 0));
        });
      case "scroll":
        // The agent's scroll: the page's own wheel under the point, as a person's, so it reaches the list there.
        return acting(guest, async (send) => {
          await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: call.x, y: call.y, deltaX: 0, deltaY: call.deltaY });
        });
      case "wheel":
        // The user's own scroll, which the shield over a driven tab passes on: no debugger, and it pauses nothing.
        guest.sendInputEvent({ type: "mouseWheel", x: Math.round(call.x), y: Math.round(call.y), deltaX: -call.deltaX, deltaY: -call.deltaY });
        return null;
      case "events":
        return sweptAndScrubbed(guest, () => activityOf(guest.id, call.since, call.kinds));
      case "capture":
        return pictureForAgent(guest);
      case "signInStop":
        return stopOf(guest);
      default:
        throw new Error("Unknown agent call");
    }
  });
}
