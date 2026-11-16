import { setBrowserHandler } from "../daemon";
import { run } from "../onboarding/api";
import { newId } from "../session/store";
import { closeTab, driveTab, selectTab, setTabUrl, type Tab, tabsOf, tabsRead } from "../shell/tab-store";
import { agentCapture, agentDrive, agentEvents, agentLoad, agentRun } from "./hands";
import { agentPage, go } from "./layer";
import { browserPage, loadStarts, openPage } from "./pages";
import { devToolsOpen, driverOf, isPaused, onPauseChanged } from "./pause";
import { onProfileChanged } from "./profiles";

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
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) return String(error.message);
  return String(error);
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const notCancelled = () => {};

/** What `call` comes to on its tab. */
async function runCall(call: Call): Promise<Result> {
  const tab: string | null = call.op.tab ?? null;
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
  }
}

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
    if (!there || !browserPage(tab)) {
      await openPage(owner, tab, op.url, backgroundBounds());
      await agentDrive(tab, true);
      await loaded(tab);
    } else {
      await agentDrive(tab, true);
    }
    return page(tab, owner);
  }
  const tab: Tab | undefined = browserTabs(owner).find((each) => each.id === op.tab);
  if (!tab) return failed(`There is no tab ${op.tab} in this session now: open one with \`brigadier browser open <url>\`.`);
  // Showing never moves the window or the session: only which tab the session has in front.
  if (op.op === "show") {
    selectTab(owner, tab.id);
    return { result: "shown", tab: tab.id };
  }
  // Worked only by its own agent, which the user's input in the tab pauses.
  const users = tab.driver !== driver;
  if (users && op.op !== "read" && op.op !== "screenshot" && op.op !== "events")
    return failed(tab.driver
      ? `Tab ${tab.id} was opened by another agent: you may read it. To work in it, \`brigadier browser open\` its address; that goes on in this tab.`
      : `Tab ${tab.id} is the user's: you may read it, not click, type, navigate or close it. Open your own with \`brigadier browser open <url>\`.`);
  if (devToolsOpen(tab.id) && op.op !== "events") return failed(DEVTOOLS_OPEN);
  // The user took it over: nothing is done until they press Continue.
  if (!users && isPaused(tab.id)) return { result: "paused", tab: tab.id };
  // Its page goes with a restart: it loads again where it was. The user may take it over meanwhile.
  if (!browserPage(tab.id)) {
    await openPage(owner, tab.id, tab.target || "about:blank", backgroundBounds());
    await loaded(tab.id);
    if (!users && isPaused(tab.id)) return { result: "paused", tab: tab.id };
  }
  if (!users) await agentDrive(tab.id, true);
  const result = await act(tab.id, op, owner, label);
  return !tab.driver && result.result === "page" ? { ...result, user: true } : result;
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
    case "click":
    case "type": {
      const before = new Set(browserTabs(owner).map((each) => each.id));
      const ask = (approved: string | null) => agentRun(tab, {
        kind: op.op,
        label,
        target: op.target,
        ...(op.op === "type" ? { text: op.text, submit: op.submit } : {}),
        declared: op.declared,
        approved,
      });
      let answer = await ask(approvedHere(tab, op.approved));
      // Full: nothing asks, so the page's own question is answered yes at once.
      if (askOf(answer) && !op.asks) answer = await ask(urlOf(answer));
      const overtaken = pausedAnswer(answer, tab);
      if (overtaken) return overtaken;
      const asked = askOf(answer);
      if (asked) {
        const shown = browserPage(tab);
        return { result: "needsApproval", tab, url: urlOf(answer) ?? shown?.url ?? "", generation: agentPage(tab).generation, ...asked };
      }
      const error = errorOf(answer);
      if (error) return failed(error);
      await settled(tab);
      return withPopups(await page(tab, owner), owner, before);
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
      return { result: "evaluated", tab, url: urlOf(answer) ?? shown?.url ?? "", text: String((answer as { text?: unknown }).text ?? "") };
    }
    case "screenshot": {
      const png = await agentCapture(tab);
      return { result: "shot", tab, url: browserPage(tab)?.url ?? "", png: base64(png) };
    }
    case "close":
      closeTab(owner, tab);
      return { result: "closed", tab };
    default:
      return failed(`Unknown browser call ${op.op}.`);
  }
}

/** The page after an action, naming the tabs it opened (a popup, such as a sign-in window): the agent goes on in them by their ids. */
function withPopups(result: Result, owner: string, before: Set<string>): Result {
  const opened = browserTabs(owner).filter((each) => !before.has(each.id));
  if (result.result !== "page" || !opened.length) return result;
  const read = result.page as { text: string };
  const lines = opened.map((each) => `(This opened a new tab: ${each.id} at ${each.target}. Use it with --tab.)`);
  return { ...result, page: { ...read, text: `${read.text}\n\n${lines.join("\n")}` } };
}

/** The address of the user's yes, while the tab is still on the page it was given on. */
function approvedHere(tab: string, approved: { generation: number; url: string } | undefined): string | null {
  return approved && approved.generation === agentPage(tab).generation ? approved.url : null;
}

const SENSITIVE = ["pay", "send", "signIn", "credentials", "card", "oneTimeCode", "script"];

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

/** Waits for the tab's page to finish loading, `LOAD_WAIT_MS` at most. */
async function loaded(tab: string): Promise<void> {
  const deadline = Date.now() + LOAD_WAIT_MS;
  while (Date.now() < deadline) {
    const shown = browserPage(tab);
    if (!shown) throw new Error("The tab closed.");
    if (shown.ready && !shown.loading) return;
    await wait(100);
  }
}

/** After an action: a moment for a load to start, then the load, if one did. */
async function settled(tab: string): Promise<void> {
  await wait(SETTLE_MS);
  await loaded(tab);
}

/** The tab's page, read for the agent. */
async function page(tab: string, owner: string): Promise<Result> {
  // shortcut: no sign-in or captcha stop before the read until S12 ports browserSignIn.
  const answer = await agentRun(tab, { kind: "read", max: READ_MOST });
  if (devToolsOpen(tab)) return failed(PAUSED_DEVTOOLS);
  const error = errorOf(answer);
  if (error) return failed(error);
  const read = answer as { url: string; title: string; text: string };
  // A tab no one has on screen follows its page here, so it opens there again after a restart (8192: tabs.rs's URL_MAX).
  if (/^https?:/i.test(read.url) && read.url.length <= 8192 && browserTabs(owner).some((each) => each.id === tab && each.target !== read.url)) setTabUrl(owner, tab, read.url);
  const shown = browserPage(tab);
  return { result: "page", tab, page: { url: read.url, title: read.title, generation: agentPage(tab).generation, loading: shown?.loading ?? false, text: read.text }, user: false };
}

/** `bytes` as base64. */
function base64(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(text);
}
