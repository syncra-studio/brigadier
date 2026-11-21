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
const { HOME, openTab, tabsOf, setHomeTabs, carryHome, setPlace, placeOf } = store;

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
  assert.equal(placeOf("q", live, "#thread/s1"), null, "none: its page");
});

test("New chat and a project's New session keep their own words [D863]", async () => {
  const kept = [];
  globalThis.window = { location: { hash: "" } };
  const store = (value) => ({ get: () => value, set: (next) => (value = next), use: () => value });
  const { draftKey, setHomeDraft, newSession, newChat } = await load("../home/start.ts", {
    "../session/draft": { HOME_DRAFT: "@home", keepDraft: (_, id, draft) => kept.push([id, draft]) },
    "../onboarding/api": { store },
  });
  newSession("p");
  assert.equal(draftKey(), "@home:p");
  newChat();
  assert.equal(draftKey(), "@home");
  setHomeDraft({ project: "p", chat: false });
  assert.equal(draftKey(), "@home", "New chat picking a project stays New chat's draft");
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
