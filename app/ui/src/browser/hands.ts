// An agent's hands on a page (agent.ts's calls): the script looks, the cursor glides to what it found, and real input
// goes in under the focus guard. The main process holds the debugger (main's browser/browserAgent.ts).
import { guardFocus, userComposing } from "./focus-guard";
import { agentPage, focusPage, loadPage, pageBounds, whilePainting } from "./layer";
import { dropOverlay, glideTo, pressAt, raiseShield } from "./overlay";
import { takeBackTab } from "./give";
import { devToolsOpen, driverOf, isPaused, userUsed } from "./pause";
import { isWindow, tabOf, windowOf, windowsOf } from "./windows";

type Answer = Record<string, unknown>;
const agent = (call: Record<string, unknown>) => window.brigadierShell.agent(call);

const script = (guest: number, op: Answer) => agent({ call: "script", guest, op }) as Promise<Answer | null>;

/** The user has the tab now: they took it over, or took it back (Stop), so nothing more goes into the page. */
const overtaken = (id: string) => isPaused(tabOf(id)) || !driverOf(tabOf(id));

const COMPOSING = "The user is typing with an input method in Brigadier, so nothing was sent, to keep their unfinished text. Try again in a moment.";

/** How long a scroll gets to move the page. */
const SCROLL_MS = 350;

/** How long an action waits for its control before input, at most, and how often it looks. */
const WAIT_MS = 5000;
const LOOK_MS = 100;
/** How often a wait looks for what ends it at once. */
const STOP_MS = 50;

/** When an action that starts now stops waiting for its control. */
export const waitLimit = () => Date.now() + WAIT_MS;

/** What one action waits for, over all its looks: until when, on which page, and what its boxes and dialogs were as the wait began. */
type Wait = { until: number; generation: number; for?: string; said?: number; modals?: number };
type Waiting = Answer & { error: string; waits: string; modals?: number };
const isWaiting = (answer: unknown): answer is Waiting => Boolean((answer as { waits?: unknown } | null)?.waits);

const sleep = (ms: number) => new Promise<undefined>((resolve) => setTimeout(resolve, ms));

/** What ends a wait at once: the user's take-over, or a page that isn't there any more. */
function stopOf(id: string, { generation }: Wait): Answer | null {
  if (overtaken(id)) return { paused: devToolsOpen(tabOf(id)) ? "devtools" : "user" };
  if (isWindow(id) && !windowOf(id)) return { error: `The window ${id} closed before its control was ready, so nothing was done.` };
  return agentPage(id).generation === generation ? null : { error: "The page went to another before its control was ready, so nothing was done. Read it again." };
}

/** Whether a refusal of `op` is still waited on. */
const waits = (op: Answer, wait: Wait) => Boolean(op.target) && Date.now() < wait.until;

/** A look at an action's control, which does nothing to it: a stop ends it without its answer. */
async function look(id: string, op: Answer, wait: Wait): Promise<Answer | null> {
  const { guest } = agentPage(id);
  const looked = script(guest, { ...op, trusted: true, waits: waits(op, wait) }).catch((error: unknown) => {
    const stop = stopOf(id, wait);
    if (stop) return stop;
    throw error;
  });
  for (;;) {
    const answer = await Promise.race([looked, sleep(STOP_MS)]);
    if (answer !== undefined) return answer;
    const stop = stopOf(id, wait);
    if (stop) return stop;
  }
}

/** The first look of `op`, once its control is still. It may act (a select, a 0x0 toggle), so it's always heard out. */
async function tried(id: string, op: Answer, wait: Wait): Promise<Answer | null> {
  if (waits(op, wait)) {
    const answer = await look(id, { ...op, still: true }, wait);
    if (!answer?.still) return answer;
    const stop = stopOf(id, wait);
    if (stop) return stop;
  }
  return script(agentPage(id).guest, { ...op, trusted: true, waits: waits(op, wait) });
}

/**
 * The first look at an action's control, once the control is ready for it: a refusal that may change is waited on, from
 * `refused` where there is one, and given at the limit. Only looks are repeated: one that did something is the answer.
 */
async function ready(id: string, op: Answer, wait: Wait, refused?: Waiting): Promise<Answer | null> {
  const first = refused ?? (await tried(id, op, wait));
  if (!isWaiting(first)) return first;
  const { guest } = agentPage(id);
  // The page's own boxes are answered from now on, where they'd hold it up.
  await agent({ call: "attach", guest }).catch(() => {});
  const said = async (keep: boolean) => (await agent({ call: "dialogs", guest, keep }).catch(() => [])) as unknown[];
  wait.said ??= (await said(true)).length;
  const { said: saidBefore } = wait;
  // A page behind its tab goes on only while it paints: what's over the control fades, and it slides.
  return await whilePainting(id, async () => {
    for (let answer: Answer | null = first; ;) {
      if (!isWaiting(answer)) return answer;
      wait.for = answer.waits;
      wait.modals ??= answer.modals;
      const opened = { error: `${answer.error} Stopped waiting for ${answer.waits}: the page opened a dialog.` };
      if ((answer.modals ?? 0) > (wait.modals ?? 0)) return opened;
      await sleep(LOOK_MS);
      // Before the look, which may find the control ready by what the box was about.
      if ((await said(true)).length > saidBefore) return { ...opened, dialogs: await said(false) };
      const stop = stopOf(id, wait);
      if (stop) return stop;
      answer = await tried(id, op, wait);
    }
  });
}

/** How often the pointer follows a control that moves from under it. */
const FOLLOWS = 5;

type Point = { x: number; y: number; depth: number };
const pointOf = (answer: unknown) => (answer as { point?: Point } | null)?.point;

/** Reads a page, or acts on one of its controls, which it waits for until `until`. */
export async function agentRun(id: string, op: Answer, until = waitLimit()): Promise<unknown> {
  const wait: Wait = { until, generation: agentPage(id).generation };
  const answer = await act(id, op, wait);
  const refusal = (answer as { error?: unknown } | null)?.error;
  if (!wait.for || typeof refusal !== "string" || Date.now() < until) return answer;
  return { ...(answer as Answer), error: `${refusal} Waited ${WAIT_MS / 1000} s for ${wait.for}.` };
}

async function act(id: string, op: Answer, wait: Wait, refused?: Waiting): Promise<unknown> {
  const { guest, element, zoom } = agentPage(id);
  if (op.kind === "press") return press(id, op, wait);
  if (op.kind === "hover" || op.kind === "scroll") {
    const answer = op.kind === "hover" ? await ready(id, op, wait) : await script(guest, op);
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
  const answer = await ready(id, op, wait, refused);
  const point = pointOf(answer);
  if (!point) return answer;

  await glideTo(id, String(op.label ?? "Brigadier"), { x: point.x * zoom, y: point.y * zoom });
  if (overtaken(id)) return { paused: "user" };

  if (op.kind === "click") {
    const clicked = await whilePainting(id, () => clickAt(id, op, point, wait));
    // Not pressed, and it may be ready yet.
    return isWaiting(clicked) ? await act(id, op, wait, clicked) : clicked;
  }
  // The field must still be the one with the focus, and what it was.
  const place = await script(guest, { ...op, kind: "place", typing: true });
  if (place && ("error" in place || "ask" in place)) return place;

  if (overtaken(id)) return { paused: "user" };
  if (userComposing()) return { error: COMPOSING };
  const release = guardFocus(element, () => focusPage(null));
  try {
    const typed = await script(guest, { kind: "insert", target: op.target, text: op.text });
    return typed && "error" in typed || op.submit !== true ? typed : await whilePainting(id, () => agent({ call: "enter", guest }));
  } finally {
    release();
  }
}

/**
 * Clicks a control whose middle was at `from`. The real pointer goes there first, so what the page does about it is done
 * before the last look at where and what the control is, and nothing moves between that look and the press. Meanwhile
 * the page paints: one behind its tab is visibility:hidden, and input sent to it reaches nothing though the call succeeds.
 */
async function clickAt(id: string, op: Answer, from: Point, wait: Wait): Promise<unknown> {
  const { guest, element, zoom } = agentPage(id);
  let at = from;
  for (let follows = 0; ; follows++) {
    await agent({ call: "hover", guest, x: at.x * zoom, y: at.y * zoom });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const place = await look(id, { ...op, kind: "place" }, wait);
    const there = pointOf(place);
    if (!there) return place;
    const moved = Math.abs(there.x - at.x) > 0.5 || Math.abs(there.y - at.y) > 0.5;
    at = there;
    if (!moved) break;
    if (follows === FOLLOWS) return { error: `${op.target} keeps moving, so it wasn't clicked. Try again in a moment.`, ...(Date.now() < wait.until ? { waits: "it to stop moving" } : {}) };
    await glideTo(id, String(op.label ?? "Brigadier"), { x: at.x * zoom, y: at.y * zoom });
    if (overtaken(id)) return { paused: "user" };
  }
  if (overtaken(id)) return { paused: "user" };
  if (userComposing()) return { error: COMPOSING };
  const release = guardFocus(element, () => focusPage(null));
  try {
    pressAt(id);
    return await agent({ call: "click", guest, x: at.x * zoom, y: at.y * zoom, look: at, confirm: op.confirm === true });
  } finally {
    release();
  }
}

/** A key, once the page's script has looked at where it goes: never a password field, and a sensitive Enter asks first. */
async function press(id: string, op: Answer, wait: Wait): Promise<unknown> {
  const { guest, element } = agentPage(id);
  const looked = await ready(id, op, wait);
  if (!looked || "error" in looked || "ask" in looked || "paused" in looked) return looked;
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
  await Promise.all(windowsOf(id).map(({ guest }) => script(guest, { kind: "void" }).catch(() => null)));
}

/** A page's address and title as its agent sees them (main's browserShownUrl.ts): no sign-in's secrets in them. */
export function agentShown(id: string, url: string, title = ""): Promise<{ url: string; title: string }> {
  return agent({ call: "shown", guest: maybePage(id)?.guest, url, title, query: isWindow(id) || isPaused(tabOf(id)) }) as Promise<{ url: string; title: string }>;
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

export async function agentCapture(id: string): Promise<{ png: Uint8Array; url: string }> {
  return await whilePainting(id, () => agent({ call: "capture", guest: agentPage(id).guest })) as { png: Uint8Array; url: string };
}
