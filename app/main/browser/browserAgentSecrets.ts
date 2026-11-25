// What keeps a password field's value from an agent, past the script's own hiding: known values scrubbed from what
// its verbs answer, and fields painted out of its pictures. The values stay here in the main process, in memory, for
// as long as the tab lives, and no call returns them. Best effort by nature: a value the page shows as text in another
// form, or a field nothing can recognise, passes.
import { readFileSync } from "node:fs";
import path from "node:path";

import { nativeImage, type NativeImage, type WebContents, type WebFrameMain } from "electron";

import { shownUrl } from "./browserShownUrl";

/** The script beside this file's source (main is built with tsc, which has no `?raw`); scripts/package ships it. */
const agentScript = readFileSync(path.join(__dirname, "../../browser/browser_agent.js"), "utf8");

/** The script's own world: the page can't reach its variables, or stand in for what it calls. */
export const AGENT_WORLD = 1010;
const scriptBody = agentScript.trim().replace(/;$/, "");
/** The agent's script, for what runs it elsewhere: the eval verb's answer and the picker's description. */
export const agentScriptBody = scriptBody;
const call = (op: object) => `(${scriptBody})(${JSON.stringify(op)}, ${shownUrl.toString()})`;

/** The most handlers a look takes, past any page's own controls, so a control late in a long page is seen at its click too. */
const HANDLED_MOST = 10_000;
/**
 * Where the page's own click handlers are, in document order: set as `onclick`, or by React, which keeps a node's props on
 * it. Only the page's world sees those, so the page can lie here: it only names more of its elements clickable.
 */
const HANDLED = `(() => {
  const found = [];
  const all = document.getElementsByTagName("*");
  for (let at = 0; at < all.length && found.length < ${HANDLED_MOST}; at++) {
    const element = all[at];
    const props = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
    if (typeof element.onclick === "function" || (props && typeof element[props]?.onClick === "function")) found.push(at);
  }
  return found;
})()`;

/** A look at the page's click handlers; none if the page wouldn't say. */
async function handledIn(guest: WebContents): Promise<number[]> {
  const answer: unknown = await guest.executeJavaScript(HANDLED).catch(() => null);
  return Array.isArray(answer) ? answer.filter((at) => Number.isInteger(at)).slice(0, HANDLED_MOST) : [];
}

/** Runs the agent's script where it tells controls with no role: a read, and a click's looks. */
export const runSeeingHandlers = async (guest: WebContents, op: object): Promise<unknown> => runScript(guest, { ...op, handled: await handledIn(guest) });

/** Runs the agent's script on the tab's page, in its own world. The op is data, and the script is the bundle's own. */
export function runScript(guest: WebContents, op: object): Promise<unknown> {
  return guest.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: call({ ...op, isolated: true }) }]);
}

type Rect = { x: number; y: number; width: number; height: number };
type Sweep = { fields: Rect[]; values: string[]; width: number; frames: { origin: string; rect: Rect }[] };

/** A value this short would blank ordinary text wherever it occurs. */
const SHORTEST = 3;
const KEPT = 50;
const HIDDEN = "(hidden)";
const FRAME_WAIT_MS = 1500;
const SWEEP_AFTER_MS = 400;

const known = new Map<number, Set<string>>();
const sweepsDue = new Map<number, ReturnType<typeof setTimeout>>();

function keep(guest: number, values: readonly string[]): void {
  let kept = known.get(guest);
  for (const value of values) {
    if (value.length < SHORTEST) continue;
    if (!kept) known.set(guest, (kept = new Set()));
    kept.delete(value);
    kept.add(value);
    if (kept.size > KEPT) kept.delete(kept.values().next().value as string);
  }
}

/** A subframe's sweep runs in its own main world, the one way into it from here: it only reads. Answers null if it can't. */
function sweepFrame(frame: WebFrameMain): Promise<Sweep | null> {
  const asked = frame.executeJavaScript(call({ kind: "sweep" })).then((answer) => answer as Sweep, () => null);
  return Promise.race([asked, new Promise<null>((resolve) => setTimeout(() => resolve(null), FRAME_WAIT_MS))]);
}

const originOf = (url: string, fallback: string) => {
  try {
    const { origin } = new URL(url);
    return origin === "null" ? fallback : origin;
  } catch {
    return fallback;
  }
};

/** The page's password fields and every frame's, with what they hold kept. Rejects if the page itself can't be looked at. */
async function sweep(guest: WebContents): Promise<{ rects: Rect[]; width: number }> {
  const main = await runScript(guest, { kind: "sweep" }) as Sweep;
  keep(guest.id, main.values);
  const rects = [...main.fields];
  const pageOrigin = originOf(guest.getURL(), "");
  const top = guest.mainFrame;
  const subframes = top.framesInSubtree.filter((frame) => frame !== top);
  const answers = await Promise.all(subframes.map(sweepFrame));
  const suspects = new Set<string>();
  answers.forEach((answer, index) => {
    if (answer) keep(guest.id, answer.values);
    // A frame's own coordinates mean nothing here, so a frame holding a field, or one that can't say, goes whole.
    if (answer && answer.fields.length === 0) return;
    let outer = subframes[index]!;
    while (outer.parent && outer.parent !== top) outer = outer.parent;
    suspects.add(originOf(outer.url, pageOrigin));
  });
  if (suspects.size > 0) {
    const matching = main.frames.filter((frame) => suspects.has(frame.origin));
    rects.push(...(matching.length > 0 ? matching : main.frames).map((frame) => frame.rect));
  }
  return { rects, width: main.width };
}

/** Looks for values soon: a page that logs often is looked at once for a burst. */
export function sweepSoon(guest: WebContents): void {
  if (sweepsDue.has(guest.id)) return;
  sweepsDue.set(guest.id, setTimeout(() => {
    sweepsDue.delete(guest.id);
    if (!guest.isDestroyed()) sweep(guest).catch(() => {});
  }, SWEEP_AFTER_MS));
}

/** Looks now: the document that holds them may be about to go. */
export function sweepNow(guest: WebContents): void {
  sweep(guest).catch(() => {});
}

export function forgetSecrets(guest: number): void {
  known.delete(guest);
  const due = sweepsDue.get(guest);
  if (due) clearTimeout(due);
  sweepsDue.delete(guest);
}

function scrubText(text: string, values: readonly string[]): string {
  let clean = text;
  for (const value of values) clean = clean.split(value).join(HIDDEN);
  return clean;
}

/** `answer` with every value known on the tab taken out of its strings, as written and as an address or form writes it. */
export function scrubbed<T>(guest: number, answer: T): T {
  const kept = known.get(guest);
  if (!kept) return answer;
  const forms = new Set<string>();
  for (const value of kept) {
    forms.add(value);
    forms.add(encodeURIComponent(value));
    forms.add(encodeURIComponent(value).replace(/%20/g, "+"));
  }
  const values = [...forms].toSorted((a, b) => b.length - a.length);
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return scrubText(value, values);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    return value;
  };
  return walk(answer) as T;
}

/** Looks for values, then answers with them scrubbed. A failed look still scrubs what is known. */
export async function sweptAndScrubbed<T>(guest: WebContents, answer: () => T | Promise<T>): Promise<T> {
  await sweep(guest).catch(() => {});
  return scrubbed(guest.id, await answer());
}

function paint(image: NativeImage, rects: readonly Rect[], pageWidth: number): Buffer {
  const scaleFactor = image.getScaleFactors()[0] ?? 1;
  const { width, height } = image.getSize(scaleFactor);
  const bitmap = image.toBitmap({ scaleFactor });
  const scale = width / pageWidth;
  for (const rect of rects) {
    const left = Math.max(0, Math.floor(rect.x * scale) - 1);
    const right = Math.min(width, Math.ceil((rect.x + rect.width) * scale) + 1);
    const top = Math.max(0, Math.floor(rect.y * scale) - 1);
    const bottom = Math.min(height, Math.ceil((rect.y + rect.height) * scale) + 1);
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const at = (y * width + x) * 4;
        // Black in either byte order, opaque.
        bitmap[at] = 0;
        bitmap[at + 1] = 0;
        bitmap[at + 2] = 0;
        bitmap[at + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor }).toPNG({ scaleFactor });
}

/** How long a page gets to draw its first frame, and how often it's asked. */
const DRAW_MS = 4000;
const DRAW_STEP_MS = 150;
/**
 * Frames the page starts before it is taken. What it was before the first is drawn by the fourth: the one after next
 * starts only once it is up, and one more is for its way to the screen.
 */
const FRAMES = `new Promise((drawn) => {
  let left = 4;
  const next = () => (left-- > 0 ? requestAnimationFrame(next) : drawn(true));
  next();
})`;
/** How long after its agent's last call a page's window goes on as if it were on screen: longer than a take. */
const AWAKE_MS = 5000;
const awake = new Map<WebContents, NodeJS.Timeout>();

/**
 * Keeps a page's window from being throttled while its agent acts. One that is hidden, covered or on another Space draws
 * nothing, its timers run once a second, and the first input after a picture waits 5 s for a frame.
 */
export function keepAwake(guest: WebContents): void {
  const host = guest.hostWebContents ?? guest;
  const last = awake.get(host);
  if (last) clearTimeout(last);
  else host.setBackgroundThrottling(false);
  awake.set(host, setTimeout(() => {
    awake.delete(host);
    if (!host.isDestroyed()) host.setBackgroundThrottling(true);
  }, AWAKE_MS));
}

/**
 * The page as drawn. A window that is hidden, covered or on another Space draws nothing, and neither do the pages in it:
 * no surface to take (UnknownVizError), or the last one they drew. It draws while it's kept awake, and the page's first
 * frame takes a moment, and for some a take that fails: one taken before the page drew again is thrown away.
 */
async function pictureOf(guest: WebContents): Promise<NativeImage> {
  let asked = Promise.resolve();
  let drew = false;
  const ask = () => {
    drew = false;
    const mine = (asked = guest.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: FRAMES }]).then(() => { drew ||= asked === mine; }, () => {}));
  };
  guest.on("did-navigate", ask);
  try {
    const until = Date.now() + DRAW_MS;
    ask();
    for (;;) {
      keepAwake(guest);
      await Promise.race([asked, new Promise((resolve) => setTimeout(resolve, DRAW_STEP_MS))]);
      const fresh = drew;
      const taken = await Promise.race([guest.capturePage(), new Promise<null>((resolve) => setTimeout(() => resolve(null), DRAW_MS))]).catch((error: unknown) => {
        if (Date.now() >= until || guest.isDestroyed()) throw error;
        return null;
      });
      if (fresh && taken && !taken.isEmpty()) return taken;
      if (Date.now() >= until) throw new Error("The page drew nothing to take a picture of, as when the Mac's screen is off. Read it instead, or try again later.");
      await new Promise((resolve) => setTimeout(resolve, DRAW_STEP_MS));
    }
  } finally {
    guest.off("did-navigate", ask);
  }
}

/** How often a page that navigates under its picture is taken again. */
const TAKES = 3;

/**
 * The page's picture for an agent and the address it is of, its password fields painted out, by looks before and after
 * it, so a field that moves while it is taken stays covered. All three are of one document: a page that navigates
 * meanwhile is taken again, then refused. A page that can't be looked at gives no picture.
 */
export async function pictureForAgent(guest: WebContents): Promise<{ png: Buffer; url: string }> {
  let moved = false;
  const onMoved = () => { moved = true; };
  guest.on("did-navigate", onMoved);
  try {
    for (let take = 0; take < TAKES; take++) {
      moved = false;
      const before = await sweep(guest).catch(() => null);
      const image = await pictureOf(guest);
      const url = guest.getURL();
      const after = await sweep(guest).catch(() => null);
      if (moved) continue;
      if (!before || !after) throw new Error("The page's password fields couldn't be found, so no picture was taken. Try again in a moment.");
      return { png: paint(image, [...before.rects, ...after.rects], after.width), url };
    }
    throw new Error("The page went to another while its picture was taken, so none was kept. Try again once it has loaded.");
  } finally {
    guest.off("did-navigate", onMoved);
  }
}
