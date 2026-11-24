import { setBrowserHandler } from "../daemon";
import { run } from "../onboarding/api";
import { newId } from "../session/store";
import { closeTab, driveTab, selectTab, setTabUrl, type Tab, tabsOf, tabsRead } from "../shell/tab-store";
import { agentCapture, agentDrive, agentEvents, agentLoad, agentRun, agentShown } from "./hands";
import { agentPage, go } from "./layer";
import { agentDoing } from "./overlay";
import { browserPage, closeBrowserPage, loadStarts, openPage } from "./pages";
import { askedOf, devToolsOpen, driverOf, isPaused, onPauseChanged, pausedFor } from "./pause";
import { onProfileChanged } from "./profiles";
import { signInCleared, signInStopOf, stopAgent, stoppedWords } from "./sign-in";
import { isWindow, tabOf, windowOf, windowsOf } from "./windows";

/**
 * Agents' browser calls (crates/cli/src/browser.rs), as the app runs them, ported from the old app's agentBrowser: a
 * call comes from the daemon, runs on a Browser tab of its session and is answered. `open` uses the agent's tab
 * already on that page, else makes a Browser tab behind the one in front, with the user's sign-ins; acting works only
 * on the calling agent's own tab. The user's own tabs may be read and shown, never worked.
 */

type Op = Record<string, any> & { op: string };
type Call = { id: string; owner: string; driver: string; label: string; op: Op };
type Result = Record<string, unknown> & { result: string };

const holdChangeFailed = (error: unknown) => console.error("changing an agent's hold of a tab failed", error);

/** Runs the daemon's calls in this window, and gives the agent its hold back or takes it as the user does. */
export function installBrowserAgent(): void {
  setBrowserHandler((frame) => {
    const call = frame as Call;
    if (call.op.op === "end") return void endTurn(call).catch(holdChangeFailed);
    void runCall(call).then((result) => run(["browser", "answer", call.id, JSON.stringify(result)])).catch(holdChangeFailed);
  });
  // The user took a tab over: the agent's hold of its page goes at once, so what they do is their own. Continue gives
  // it back as it was, except that refs from before the user's turn are void.
  onPauseChanged(({ paused }, before) => {
    for (const tab of Object.keys(paused)) {
      if (!(tab in before.paused)) agentDrive(tab, false).catch(holdChangeFailed);
    }
    for (const tab of Object.keys(before.paused)) {
      if (!(tab in paused) && driverOf(tab)) agentDrive(tab, true, true).catch(holdChangeFailed);
    }
  });
  onProfileChanged(({ tabId }) => profileChanged(tabId));
}

/**
 * The agent's turn ended (crates/cli/src/browser/hub.rs): it lets go of its tabs, which stay open in its group, the
 * user's to use until its next turn, as Claude in Chrome's [D894 D901].
 */
async function endTurn({ owner, driver }: Call): Promise<void> {
  await tabsRead(owner);
  for (const tab of browserTabs(owner)) {
    // A tab with no driver now was ungrouped as it ended, as an archive does: its hold goes too.
    if (tab.driver === driver || !tab.driver) agentDrive(tab.id, false).catch(holdChangeFailed);
  }
}

/** Its page goes with it: a tab of a session not on screen has no view whose unmount would close it. */
function closeAgentTab(owner: string, tab: string): void {
  closeTab(owner, tab);
  closeBrowserPage(tab);
}

const PROFILE_CHANGED = "profile_changed: this tab's profile was deleted, so it moved to the user's default profile. Your refs are void and what it's signed in to may differ. Nothing was done: read it again before going on, and don't assume you are still the same user on the site.";

/** The calls under way on a tab, cancelled when its profile goes. */
const underWay = new Map<string, Set<(result: Result) => void>>();
/** Tabs whose agent has yet to hear that the profile changed, which it hears once. */
const moved = new Set<string>();

/**
 * A move takes tab `tab` to another profile, about to close its page. Calls under way end now, the hold goes, and the
 * agent's next call hears it once if none was under way to hear it: it mustn't carry on as someone else.
 */
function profileChanged(tab: string): void {
  if (!driverOf(tab)) return;
  agentDrive(tab, false).catch(() => {});
  const calls = underWay.get(tab);
  if (!calls?.size) {
    moved.add(tab);
    return;
  }
  for (const end of calls) end(failed(PROFILE_CHANGED));
  calls.clear();
}

const TAKEN_BACK = "taken_back: the user took this tab back, so it's theirs now and nothing more was done. You may read it, not act in it.";

/** The user took tab `tab` back from its agent [D775]: the hold goes, and what was under way there ends now. */
export function takenBack(tab: string): void {
  agentDrive(tab, false).catch(() => {});
  for (const end of underWay.get(tab) ?? []) end(failed(TAKEN_BACK));
  underWay.get(tab)?.clear();
}

/** An in-flight call the user's take-over or DevTools overtook. */
function pausedAnswer(answer: unknown, tab: string): Result | null {
  if (typeof answer !== "object" || !answer || !("paused" in answer)) return null;
  return answer.paused === "devtools" ? failed(PAUSED_DEVTOOLS) : { result: "paused", tab };
}

const PAUSED_DEVTOOLS = "Paused: DevTools open. The user has this tab; nothing was done. Calls on it answer devtools_open until they close DevTools and press Continue; `events` still works. Your refs on it are void then: read it again.";
const DEVTOOLS_OPEN = "devtools_open: DevTools is open on this tab, so nothing was done, and it stays open. `events` still works. It goes on when the user closes DevTools and presses Continue.";

/** How long a page load may take before the agent hears the page as it is then. */
const LOAD_WAIT_MS = 20_000;
/** How long after a click or typing a page gets to start loading, if it will. */
const SETTLE_MS = 400;
/** The most of a page's text one read gives: under the CLI's answer cap. */
const READ_MOST = 15_000;

const failed = (message: string): Result => ({ result: "failed", message });

function messageOf(error: unknown): string {
  // A refusal thrown in main comes wrapped by IPC: the agent hears only its words.
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  if (typeof error === "object" && error && "message" in error) return String(error.message);
  return String(error);
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const notCancelled = () => {};

/** What `call` comes to on its tab. */
async function runCall(call: Call): Promise<Result> {
  const tab: string | null = typeof call.op.tab === "string" ? tabOf(call.op.tab) : null;
  if (tab !== null && moved.delete(tab)) return failed(PROFILE_CHANGED);
  let end: (result: Result) => void = notCancelled;
  const cancelled = new Promise<Result>((resolve) => { end = resolve; });
  if (tab !== null) underWay.set(tab, (underWay.get(tab) ?? new Set()).add(end));
  try {
    return await Promise.race([perform(call), cancelled]);
  } catch (error) {
    return failed(messageOf(error));
  } finally {
    if (tab !== null) underWay.get(tab)?.delete(end);
    if (tab !== null) agentDoing(tab, null);
  }
}

/** What a driven tab's notice bar says its agent does during each call. */
const DOING: Record<string, string> = {
  open: "Opening a page",
  navigate: "Opening a page",
  go: "Going back or on",
  read: "Reading the page",
  click: "Clicking",
  type: "Typing",
  press: "Pressing a key",
  hover: "Pointing",
  scroll: "Scrolling",
  wait: "Waiting for the page",
  screenshot: "Looking at the page",
  eval: "Running a script",
};

const browserTabs = (owner: string) => tabsOf(owner).tabs.filter((tab) => tab.kind === "browser");

function sameAddress(a: string | undefined, b: string): boolean {
  try {
    return new URL(a ?? "").href === new URL(b).href;
  } catch {
    return false;
  }
}

/** Where a background tab's page lies: over the session's main area, which it would show in. */
function backgroundBounds() {
  const area = document.querySelector('[data-slot="pane-workspace"]')?.getBoundingClientRect();
  if (area && area.width > 200 && area.height > 200) return { x: area.left, y: area.top, width: area.width, height: area.height };
  return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
}

async function perform({ op, owner, driver, label }: Call): Promise<Result> {
  await tabsRead(owner);
  if (op.op === "open") {
    // A tab an agent works on that page goes on, not another one of it, unless the user took it over.
    const there = browserTabs(owner).find((tab) => Boolean(tab.driver) && sameAddress(tab.target, op.url) && !isPaused(tab.id));
    const tab = there?.id ?? `t-${newId()}`;
    driveTab(owner, tab, op.url, driver);
    agentDoing(tab, DOING.open);
    try {
      if (!there || !browserPage(tab)) {
        await openPage(owner, tab, op.url, backgroundBounds());
        await agentDrive(tab, true);
        await loaded(tab);
      } else {
        await agentDrive(tab, true);
      }
      return await page(tab, owner);
    } finally {
      agentDoing(tab, null);
    }
  }
  if (op.op === "tabs") {
    const { active } = tabsOf(owner);
    const tabs = await Promise.all(browserTabs(owner).flatMap((each) => {
      const shown = browserPage(each.id);
      const whose = { driver: each.driver ?? "", paused: isPaused(each.id), asked: Boolean(askedOf(each.id)) };
      const opened = windowsOf(each.id).map(({ id, title, url }) => ({ id, title, url, ...whose, front: false, window: true }));
      return [{ id: each.id, title: shown?.title ?? "", url: shown?.url || each.target || "", ...whose, front: active === each.id }, ...opened];
    }).map(async (each) => ({ ...each, ...(await agentShown(each.id, each.url, each.title)) })));
    return { result: "tabs", tabs };
  }
  const tab: Tab | undefined = browserTabs(owner).find((each) => each.id === tabOf(String(op.tab)));
  if (!tab) return failed(`There is no tab ${op.tab} in this session now: open one with \`brigadier browser open <url>\`.`);
  const opened = isWindow(op.tab) ? op.tab as string : null;
  if (opened && !windowOf(opened)) return failed(`The window ${opened} closed. Its tab is ${tab.id}.`);
  if (opened && TABS_ONLY.has(op.op)) return failed(`\`${op.op}\` works on a tab, not on a window its page opened: ${opened} is one, of ${tab.id}.`);
  // Showing never moves the window or the session: only which tab the session has in front.
  if (op.op === "show") {
    selectTab(owner, tab.id);
    return { result: "shown", tab: tab.id };
  }
  // Worked only by its own agent, which the user's input in the tab pauses.
  const users = tab.driver !== driver;
  if (users && !READ_ONLY.has(op.op))
    return failed(tab.driver
      ? `Tab ${tab.id} was opened by another agent: you may read it. To work in it, \`brigadier browser open\` its address; that goes on in this tab.`
      : `Tab ${tab.id} is the user's: you may read it, not click, type, navigate or close it. Open your own with \`brigadier browser open <url>\`.`);
  if (devToolsOpen(tab.id) && op.op !== "events") return failed(DEVTOOLS_OPEN);
  // The user took it over: nothing is done until they press Continue.
  if (!users && isPaused(tab.id)) return { result: "paused", tab: opened ?? tab.id };
  // Its page goes with a restart: it loads again where it was. The user may take it over meanwhile.
  if (!browserPage(tab.id)) {
    await openPage(owner, tab.id, tab.target || "about:blank", backgroundBounds());
    await loaded(tab.id);
    if (!users && isPaused(tab.id)) return { result: "paused", tab: opened ?? tab.id };
  }
  if (!users) {
    agentDoing(tab.id, DOING[op.op] ?? null);
    await agentDrive(tab.id, true);
  }
  const result = await act(opened ?? tab.id, op, owner, label);
  return !tab.driver && result.result === "page" ? { ...result, user: true } : result;
}

/** The calls that only look, which work on any tab of the session. */
const READ_ONLY = new Set(["read", "screenshot", "events", "wait"]);
/** The calls a window a page opened doesn't take. */
const TABS_ONLY = new Set(["navigate", "go", "eval", "ask", "show", "close"]);
/** The longest an agent's `wait` waits. */
const WAIT_MOST_MS = 20_000;

/** The page after a `wait` for `op.text` to show, or `op.gone` to go; said so when it didn't. */
async function waited(tab: string, op: Op, owner: string): Promise<Result> {
  const ms = Math.min(Number(op.ms) || WAIT_MOST_MS, WAIT_MOST_MS);
  const wanted = String(op.text ?? op.gone ?? "");
  if (!wanted) {
    if (op.ms) await wait(ms);
    else await loaded(tab);
    return page(tab, owner);
  }
  const deadline = Date.now() + ms;
  const needle = wanted.toLowerCase();
  for (;;) {
    if (isPaused(tabOf(tab))) return { result: "paused", tab };
    const answer = await agentRun(tab, { kind: "read", max: READ_MOST });
    const there = String((answer as { text?: unknown } | null)?.text ?? "").toLowerCase().includes(needle);
    if (there === Boolean(op.text)) return page(tab, owner);
    if (Date.now() >= deadline) {
      const note = `Waited ${Math.round(ms / 1000)} s: ${JSON.stringify(wanted)} ${op.text ? "didn't show" : "is still there"}.`;
      return { ...(await page(tab, owner)), note };
    }
    await wait(250);
  }
}

async function act(tab: string, op: Op, owner: string, label: string): Promise<Result> {
  switch (op.op) {
    case "events": {
      const { lines, next, dropped } = await agentEvents(tab, Number(op.since), op.kinds) as Record<string, unknown>;
      return { result: "events", tab, lines, next, dropped };
    }
    case "navigate":
      loadStarts(tab);
      agentLoad(tab, op.url);
      await loaded(tab);
      return page(tab, owner);
    case "go":
      go(tab, op.action);
      await settled(tab);
      return page(tab, owner);
    case "read":
      return page(tab, owner);
    case "wait":
      return waited(tab, op, owner);
    case "hover":
    case "scroll": {
      const answer = await agentRun(tab, { kind: op.op, label, target: op.target, way: op.way });
      const overtaken = pausedAnswer(answer, tab);
      if (overtaken) return overtaken;
      const error = errorOf(answer);
      if (error) return failed(error);
      await settled(tab);
      return withDialogs(await page(tab, owner), answer);
    }
    case "click":
    case "type":
    case "press": {
      const before = idsNow(owner);
      const ask = (approved: string | null) => agentRun(tab, {
        kind: op.op,
        label,
        target: op.target,
        ...(op.op === "type" ? { text: op.text, submit: op.submit } : {}),
        ...(op.op === "press" ? { key: op.key, modifiers: op.modifiers } : {}),
        confirm: op.confirm,
        declared: op.declared,
        always: op.always,
        approved,
      }).catch(async (error: unknown) => {
        // A window may close on the very click, as Approve's does, before the click's own answer comes.
        await wait(SETTLE_MS);
        if (!isWindow(tab) || windowOf(tab)) throw error;
        return { done: true };
      });
      let answer = await ask(approvedHere(tab, op.approved));
      // Full: nothing asks, so the page's own question is answered yes at once.
      if (askOf(answer) && !op.asks) answer = await ask(urlOf(answer));
      const overtaken = pausedAnswer(answer, tab);
      if (overtaken) return overtaken;
      const asked = askOf(answer);
      if (asked) {
        const shown = shownPage(tab);
        return { result: "needsApproval", tab, url: urlOf(answer) ?? shown?.url ?? "", generation: agentPage(tab).generation, ...asked };
      }
      const error = errorOf(answer);
      if (error) return failed(error);
      const left = await settled(tab);
      const after = withDialogs(await withPopups(await page(left, owner), owner, before), answer);
      return left === tab ? after : { ...after, note: [after.note, `The window ${tab} closed; this is its tab.`].filter(Boolean).join(" ") };
    }
    case "eval": {
      // At Auto a run asks: a yes goes with one call, on the page it was given on.
      const shown = browserPage(tab);
      if (op.asks && approvedHere(tab, op.approved) !== shown?.url) {
        return { result: "needsApproval", tab, url: shown?.url ?? "", generation: agentPage(tab).generation, sensitive: "script", what: "" };
      }
      const answer = await agentRun(tab, { kind: "eval", script: op.script });
      const error = errorOf(answer);
      if (error) return failed(error);
      const { url } = await agentShown(tab, urlOf(answer) ?? shown?.url ?? "");
      return { result: "evaluated", tab, url, text: String((answer as { text?: unknown }).text ?? "") };
    }
    case "screenshot": {
      const shot = await agentCapture(tab);
      const { url } = await agentShown(tab, shot.url);
      return { result: "shot", tab, url, png: base64(shot.png) };
    }
    case "ask": {
      // The tab is the user's until Done, in front within its session only: no window moves and no focus goes.
      pausedFor(tab, { kind: "ask", what: String(op.what), site: "", key: `ask:${Date.now()}` });
      selectTab(owner, tab);
      return { result: "asked", tab };
    }
    case "close":
      closeAgentTab(owner, tab);
      return { result: "closed", tab };
    default:
      return failed(`Unknown browser call ${op.op}.`);
  }
}

/** The session's browser tabs and the windows their pages opened. */
const idsNow = (owner: string) => new Set(browserTabs(owner).flatMap((each) => [each.id, ...windowsOf(each.id).map(({ id }) => id)]));

/** The page after an action, naming the tabs and windows it opened: the agent goes on in them by their ids. */
async function withPopups(result: Result, owner: string, before: Set<string>): Promise<Result> {
  const opened = [...idsNow(owner)].filter((id) => !before.has(id));
  if (result.result !== "page" || !opened.length) return result;
  const read = result.page as { text: string };
  const lines = await Promise.all(opened.map(async (id) => {
    const { url } = await agentShown(id, windowOf(id)?.url ?? browserTabs(owner).find((each) => each.id === id)?.target ?? "");
    return `(This opened a new ${isWindow(id) ? "window" : "tab"}: ${id} at ${url}. Use it with --tab.)`;
  }));
  return { ...result, page: { ...read, text: `${read.text}\n\n${lines.join("\n")}` } };
}

/** What the page asked in a box while the agent acted (main's browserAgentDialogs.ts), as a note above the page [D781]. */
function withDialogs(result: Result, answer: unknown): Result {
  const said = (answer as { dialogs?: { kind: string; message: string; yes?: boolean }[] } | null)?.dialogs;
  if (result.result !== "page" || !Array.isArray(said) || !said.length) return result;
  const lines = said.map(({ kind, message, yes }) => {
    const words = JSON.stringify(message);
    if (kind === "alert") return `The page showed an alert, answered OK: ${words}.`;
    if (kind === "prompt") return `The page asked for text and got none: ${words}.`;
    return yes ? `The page asked to confirm, answered OK: ${words}.` : `The page asked to confirm, answered Cancel, so what it guards wasn't done: ${words}. To answer OK, do it again with --confirm.`;
  });
  return { ...result, note: [result.note, ...lines].filter(Boolean).join(" ") };
}

/** The address of the user's yes, while the tab is still on the page it was given on. */
function approvedHere(tab: string, approved: { generation: number; url: string } | undefined): string | null {
  return approved && approved.generation === agentPage(tab).generation ? approved.url : null;
}

const SENSITIVE = ["pay", "send", "delete", "signIn", "credentials", "card", "oneTimeCode", "script", "action"];

function askOf(answer: unknown): { sensitive: string; what: string } | null {
  if (typeof answer !== "object" || !answer || !("ask" in answer)) return null;
  const ask = answer.ask as { sensitive?: unknown; what?: unknown };
  const sensitive = SENSITIVE.find((each) => each === ask.sensitive);
  return sensitive ? { sensitive, what: String(ask.what ?? "") } : null;
}

function errorOf(answer: unknown): string | null {
  if (typeof answer !== "object" || !answer) return "The page didn't answer.";
  return "error" in answer ? String(answer.error) : null;
}

function urlOf(answer: unknown): string | null {
  return typeof answer === "object" && answer && "url" in answer ? String(answer.url) : null;
}

/** What's loaded in a tab, or in a window its page opened. */
const shownPage = (id: string): { url: string; title: string; loading: boolean; ready?: boolean } | undefined => {
  const opened = windowOf(id);
  return opened ? { ...opened, ready: true } : browserPage(id);
};

/** Waits for the tab's page to finish loading, `LOAD_WAIT_MS` at most. */
async function loaded(tab: string): Promise<void> {
  const deadline = Date.now() + LOAD_WAIT_MS;
  while (Date.now() < deadline) {
    const shown = shownPage(tab);
    if (!shown) throw new Error("The tab closed.");
    if (shown.ready && !shown.loading) return;
    await wait(100);
  }
}

/** After an action: a moment for a load to start, then the load, if one did. A window that closed leaves its tab. */
async function settled(tab: string): Promise<string> {
  await wait(SETTLE_MS);
  const left = isWindow(tab) && !windowOf(tab) ? tabOf(tab) : tab;
  await loaded(left);
  return left;
}

/** The tab's page, read for the agent. */
async function page(tab: string, owner: string): Promise<Result> {
  const stopped = await stoppedAt(tab);
  if (stopped) return stopped;
  const answer = await agentRun(tab, { kind: "read", max: READ_MOST });
  if (devToolsOpen(tabOf(tab))) return failed(PAUSED_DEVTOOLS);
  const error = errorOf(answer);
  if (error) return failed(error);
  const read = answer as { url: string; title: string; text: string };
  // A tab no one has on screen follows its page here, so it opens there again after a restart (8192: tabs.rs's URL_MAX).
  if (/^https?:/i.test(read.url) && read.url.length <= 8192 && browserTabs(owner).some((each) => each.id === tab && each.target !== read.url)) setTabUrl(owner, tab, read.url);
  const shown = shownPage(tab);
  return { result: "page", tab, page: { ...(await agentShown(tab, read.url, read.title)), generation: agentPage(tab).generation, loading: shown?.loading ?? false, text: read.text }, user: false };
}

/**
 * What the agent hears on a page that stops it: the action it asked for is done, so this is its answer and not `paused`,
 * which the daemon would run again after Continue. Its next call on the tab waits.
 */
async function stoppedAt(id: string): Promise<Result | null> {
  const tab = tabOf(id);
  if (!driverOf(tab)) return null;
  let stop = askedOf(tab);
  if (!stop && !isPaused(tab)) {
    const found = await signInStopOf(id);
    if (!found) {
      if (!isWindow(id)) signInCleared(tab);
    } else if (stopAgent(tab, { ...found, window: isWindow(id) })) stop = found;
  }
  if (!stop) return null;
  const shown = shownPage(tab);
  const read = { ...(await agentShown(id, shown?.url ?? "", shown?.title)), generation: agentPage(tab).generation, loading: shown?.loading ?? false, text: stoppedWords(stop, tab) };
  return { result: "page", tab: id, page: read, user: false, stopped: true };
}

/** `bytes` as base64. */
function base64(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(text);
}
