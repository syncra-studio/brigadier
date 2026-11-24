// An agent's hands on a page (agent.ts's calls): the script looks, the cursor glides to what it found, and real input
// goes in under the focus guard. The main process holds the debugger (main's browser/browserAgent.ts).
import { guardFocus, userComposing } from "./focus-guard";
import { agentPage, focusPage, loadPage, pageBounds, whilePainting } from "./layer";
import { dropOverlay, glideTo, pressAt, raiseShield } from "./overlay";
import { takeBackTab } from "./give";
import { driverOf, isPaused, userUsed } from "./pause";
import { tabOf } from "./windows";

type Answer = Record<string, unknown>;
const agent = (call: Record<string, unknown>) => window.brigadierShell.agent(call);

const script = (guest: number, op: Answer) => agent({ call: "script", guest, op }) as Promise<Answer | null>;

/** The user has the tab now: they took it over, or took it back (Stop), so nothing more goes into the page. */
const overtaken = (id: string) => isPaused(tabOf(id)) || !driverOf(tabOf(id));

/** How long a scroll gets to move the page. */
const SCROLL_MS = 350;

const pointOf = (answer: unknown) => (answer as { point?: { x: number; y: number } } | null)?.point;

/** Reads a page, or acts on one of its controls. */
export async function agentRun(id: string, op: Answer): Promise<unknown> {
  const { guest, element, zoom } = agentPage(id);
  if (op.kind === "press") return press(id, op);
  if (op.kind === "hover" || op.kind === "scroll") {
    const answer = await script(guest, op);
    const point = pointOf(answer);
    if (!point) return answer;
    const at = { x: point.x * zoom, y: point.y * zoom };
    if (op.kind === "hover") await glideTo(id, String(op.label ?? "Brigadier"), at);
    if (overtaken(id)) return { paused: "user" };
    const scrolled = Number((answer as { scroll?: unknown }).scroll ?? 0) * zoom;
    // A scroll is the page's own wheel under its middle, as a person's: it reaches the list there, not only the window.
    if (op.kind === "hover") return await whilePainting(id, () => agent({ call: "hover", guest, ...at }));
    // A page behind its tab paints only meanwhile, and its scroll moves only while it paints.
    return await whilePainting(id, async () => {
      const answer = await agent({ call: "scroll", guest, ...at, deltaY: scrolled });
      await new Promise((resolve) => setTimeout(resolve, SCROLL_MS));
      return answer;
    });
  }
  if (op.kind !== "click" && op.kind !== "type") return script(guest, op);
  const answer = await script(guest, { ...op, trusted: true });
  const point = (answer as { point?: { x: number; y: number } } | null)?.point;
  if (!point) return answer;

  await glideTo(id, String(op.label ?? "Brigadier"), { x: point.x * zoom, y: point.y * zoom });
  if (overtaken(id)) return { paused: "user" };

  // The real pointer goes there first, so a menu that opened on hover closes and the page settles before the check.
  if (op.kind === "click") {
    await whilePainting(id, () => agent({ call: "hover", guest, x: point.x * zoom, y: point.y * zoom }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // The page may have moved while the cursor went; a field must still be the one with the focus.
  const place = await script(guest, { kind: "place", target: op.target, typing: op.kind === "type" });
  if (place && "error" in place) return place;
  const there = (place as { point?: { x: number; y: number } } | null)?.point ?? point;

  if (overtaken(id)) return { paused: "user" };
  if (userComposing()) return { error: "The user is typing with an input method in Brigadier, so nothing was sent, to keep their unfinished text. Try again in a moment." };
  const release = guardFocus(element, () => focusPage(null));
  try {
    if (op.kind === "type") {
      const typed = await script(guest, { kind: "insert", target: op.target, text: op.text });
      return typed && "error" in typed || op.submit !== true ? typed : await whilePainting(id, () => agent({ call: "enter", guest }));
    }
    if (Math.abs(there.x - point.x) > 0.5 || Math.abs(there.y - point.y) > 0.5) await glideTo(id, String(op.label ?? "Brigadier"), { x: there.x * zoom, y: there.y * zoom });
    pressAt(id);
    // A page behind its tab is visibility:hidden, and input sent to it reaches nothing though the call succeeds.
    return await whilePainting(id, () => agent({ call: "click", guest, x: there.x * zoom, y: there.y * zoom, confirm: op.confirm === true }));
  } finally {
    release();
  }
}

/** A key, once the page's script has looked at where it goes: never a password field, and a sensitive Enter asks first. */
async function press(id: string, op: Answer): Promise<unknown> {
  const { guest, element } = agentPage(id);
  const ready = await script(guest, { ...op, kind: "press" });
  if (!ready || "error" in ready || "ask" in ready) return ready;
  if (overtaken(id)) return { paused: "user" };
  if (userComposing()) return { error: "The user is typing with an input method in Brigadier, so no key was sent, to keep their unfinished text. Try again in a moment." };
  const release = guardFocus(element, () => focusPage(null));
  try {
    return await whilePainting(id, () => agent({ call: "key", guest, key: op.key, modifiers: op.modifiers }));
  } finally {
    release();
  }
}

/** An agent has the tab now (the shield goes up), or doesn't (it comes down, and the debugger goes). */
export async function agentDrive(id: string, on: boolean, resumed = false): Promise<void> {
  if (!on) {
    dropOverlay(id, true);
    const page = maybePage(id);
    if (page) await agent({ call: "release", guest: page.guest });
    return;
  }
  const page = maybePage(id);
  const element = page?.element;
  if (!element || !driverOf(id)) return;
  raiseShield(id, element, pageBounds(id), () => {
    // Take over: the tab is the user's until they hand it back, and so is the keyboard.
    dropOverlay(id);
    userUsed(id);
    element.focus();
  }, ({ x, y, deltaX, deltaY }) => void agent({ call: "wheel", guest: page.guest, x, y, deltaX, deltaY }), () => {
    // Stop: as the tab menu's Take back, the tab is the user's for good.
    const owner = driverOf(id);
    if (owner) takeBackTab(owner.session, id);
  });
  if (!resumed) return;
  // Continue: the hold comes back as it was, and refs from before the user's turn mean nothing now.
  await agent({ call: "attach", guest: page.guest });
  await script(page.guest, { kind: "void" });
}

function maybePage(id: string) {
  try {
    return agentPage(id);
  } catch {
    return null;
  }
}

export function agentLoad(id: string, url: string): void {
  if (!/^https?:/i.test(url)) throw new Error(`${url} isn't a web address.`);
  loadPage(id, url);
}

export function agentEvents(id: string, since: number, kinds: readonly string[]): Promise<unknown> {
  return agent({ call: "events", guest: agentPage(id).guest, since, kinds });
}

export async function agentCapture(id: string): Promise<Uint8Array> {
  return await whilePainting(id, () => agent({ call: "capture", guest: agentPage(id).guest })) as Uint8Array;
}
