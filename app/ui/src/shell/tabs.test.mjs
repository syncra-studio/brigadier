import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { moduleRunnerTransform, transformWithOxc } from "vite";

// Loads one module with its imports replaced: `stubs` by path, the rest inert.
const stub = () => new Proxy(function () {}, { get: (_, name) => (name === "then" ? undefined : stub()), apply: () => stub() });
async function load(file, stubs = {}) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const { code } = await moduleRunnerTransform((await transformWithOxc(source, file)).code, null, file, source);
  const exports = {};
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction("__vite_ssr_import__", "__vite_ssr_exportName__", code)((path) => stubs[path] ?? stub(), (name, get) => Object.defineProperty(exports, name, { get }));
  return exports;
}

const asked = [];
const store = await load("./tab-store.ts", {
  react: { useEffect: () => {}, useSyncExternalStore: (_, get) => get() },
  "../session/draft": { HOME_DRAFT: "@home" },
  "../daemon": { ask: (request) => asked.push(request.args), useDaemon: () => ({}) },
  "../session/store": { newId: () => String(asked.length) },
});
const { HOME, openTab, tabsOf, setHomeTabs, carryHome, setPlace, placeOf, pageKey, pageTabLast, homeProject } = store;

test("New chat and a project's New session keep their own tabs [D859 D863]", () => {
  setHomeTabs("p");
  openTab(HOME, "new");
  setHomeTabs(null);
  assert.equal(tabsOf(HOME).tabs.length, 0, "New chat doesn't show the project draft's tab");
  openTab(HOME, "terminal");
  openTab("s1", "new");
  setHomeTabs("p");
  assert.deepEqual(tabsOf(HOME).tabs.map((tab) => tab.kind), ["new"], "nor the project's draft New chat's or a session's");
  carryHome("s2", () => {});
  assert.deepEqual(tabsOf("s2").tabs.map((tab) => tab.kind), ["new"]);
  assert.equal(tabsOf(HOME).tabs.length, 0, "sent, the draft is empty again");
  assert.ok(asked.some((args) => args[1] === "@home:p") && asked.some((args) => args[1] === "@home"));
});

test("a project's page keeps its own tabs: \"+\" there never shows in its New session [D859 D875]", () => {
  setHomeTabs("r", true);
  assert.equal(homeProject(), "r");
  openTab(HOME, "new");
  assert.deepEqual(tabsOf(pageKey("r")).tabs.map((tab) => tab.kind), ["new"], "the page's New tab, in front");
  assert.equal(tabsOf(pageKey("r")).active, tabsOf(pageKey("r")).tabs[0].id);
  setHomeTabs("r");
  assert.equal(tabsOf(HOME).tabs.length, 0, "the project's draft has none of it");
  assert.ok(asked.some((args) => args[1] === "@home:r--page" && args[2] === "open"));
  setPlace("r", pageKey("r"));
  assert.ok(pageTabLast("r"), "left on it, the page opens on it again");
  assert.equal(placeOf("r", () => false, ""), null, "by way of the page");
  setPlace("r", "");
  assert.ok(!pageTabLast("r"));
});

test("a project's click goes back to its last place [D865]", () => {
  const live = (id) => id === "s1";
  assert.equal(placeOf("q", live, ""), null, "nothing used there yet: its page");
  setPlace("q", "s1");
  assert.equal(placeOf("q", live, "#project/q"), "s1");
  assert.equal(placeOf("q", live, "#thread/s1"), null, "already there: its page");
  setPlace("q", "gone");
  assert.equal(placeOf("q", live, ""), null, "a session no longer listed: its page");
  setPlace("q", HOME);
  assert.equal(placeOf("q", live, "#project/q"), HOME, "its draft");
  setPlace("q", "");
  assert.equal(placeOf("q", live, "#thread/s1"), null, "the house last: its page");
});

test("on a project's page the keys act on the session its row shows, and open it [D859]", async () => {
  let handler;
  const calls = [];
  globalThis.window = { addEventListener: (_, f) => (handler = f), removeEventListener() {}, location: { hash: "#project/p" } };
  const { useTabKeys } = await load("./tab-keys.ts", {
    react: { useEffect: (f) => f() },
    "../shortcuts": { matches: (event, id) => event.id === id },
    "./titlebar": { blocked: () => false },
    "./tab-store": { HOME, openTab: (...args) => calls.push(args) },
  });
  const press = (id) => handler({ id, preventDefault() {}, stopPropagation() {} });
  useTabKeys(HOME, false, "s1");
  press("new-tab");
  assert.deepEqual(calls.pop(), ["s1", "new"]);
  assert.equal(window.location.hash, "#thread/s1");
  useTabKeys(HOME, false, "@home:p");
  press("new-tab");
  assert.deepEqual(calls.pop(), ["@home:p", "new"], "its draft current: in the draft, on its page");
  assert.equal(window.location.hash, "");
  window.location.hash = "#project/p";
  useTabKeys(HOME, false);
  press("new-tab");
  assert.deepEqual(calls.pop(), [HOME, "new"], "with nothing current, Home's tabs: the page's own there [D875]");
  assert.equal(window.location.hash, "#project/p");
});

test("New chat and a project's New session keep their own words [D863]", async () => {
  const kept = [];
  globalThis.window = { location: { hash: "" } };
  const store = (value) => ({ get: () => value, set: (next) => (value = next), use: () => value });
  const { draftKey, setHomeDraft, newSession, newChat, dropDraft } = await load("../home/start.ts", {
    "../session/draft": { HOME_DRAFT: "@home", keepDraft: (_, id, draft) => kept.push([id, draft]) },
    "../onboarding/api": { store },
  });
  newSession("p");
  assert.equal(draftKey(), "@home:p");
  newChat();
  assert.equal(draftKey(), "@home");
  setHomeDraft({ project: "p", chat: false });
  assert.equal(draftKey(), "@home", "New chat picking a project stays New chat's draft");
  dropDraft("p");
  assert.deepEqual(kept.map(([id]) => id), ["@home:p"], "the project draft's × clears its own words only");
});

test("from New chat a project picked or clicked opens its last place, never New chat in that project [D886 D891]", async () => {
  const drafts = [];
  globalThis.window = { location: { hash: "" } };
  const { useOpenPlace } = await load("../projects/page.tsx", {
    "../daemon": { useDaemon: () => ({ rows: [{ id: "s9", archived: false }] }) },
    "../shell/tab-store": store,
    "../home/start": { setHomeDraft: (change) => drafts.push(change) },
  });
  const open = useOpenPlace();
  setHomeTabs(null);
  open("n");
  assert.equal(window.location.hash, "#project/n", "nothing used there yet: its page");
  window.location.hash = "";
  setPlace("n", "s9");
  open("n");
  assert.equal(window.location.hash, "#thread/s9", "its last session");
  window.location.hash = "";
  setPlace("n", HOME);
  open("n");
  assert.deepEqual(drafts, [{ project: "n", chat: false, locked: true }], "its own draft, locked, not New chat's");
});
