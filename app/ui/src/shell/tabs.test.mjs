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
const { HOME, openTab, tabsOf, setHomeTabs, carryHome } = store;

test("Chats and a project keep their own tabs [D859]", () => {
  setHomeTabs("p");
  openTab(HOME, "new");
  setHomeTabs(null);
  assert.equal(tabsOf(HOME).tabs.length, 0, "Chats' draft doesn't show the project draft's tab");
  openTab(HOME, "terminal");
  openTab("s1", "new");
  setHomeTabs("p");
  assert.deepEqual(tabsOf(HOME).tabs.map((tab) => tab.kind), ["new"], "nor the project's draft Chats' or a session's");
  carryHome("s2", () => {});
  assert.deepEqual(tabsOf("s2").tabs.map((tab) => tab.kind), ["new"]);
  assert.equal(tabsOf(HOME).tabs.length, 0, "sent, the draft is empty again");
  assert.ok(asked.some((args) => args[1] === "@home:p") && asked.some((args) => args[1] === "@home"));
});

test("Each project has one draft and Chats one; New chat goes back to the one last open", async () => {
  const words = new Map([["@home:full", { parts: ["words"] }]]);
  const took = [];
  globalThis.window = { location: { hash: "" } };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const store = (value) => ({ get: () => value, set: (next) => (value = next), use: () => value });
  const { draftKey, useHomeDraft, setHomeDraft, newSession, newChat, pickHomeProject } = await load("../home/start.ts", {
    "../components/composer/draft": { EMPTY_DRAFT: { parts: [] }, isEmpty: (d) => d.parts.length === 0 },
    "../session/draft": { HOME_DRAFT: "@home", loadDraft: async (_, id) => words.has(id) || words.set(id, { parts: [] }), draftOf: (id) => words.get(id), moveDraft: (_, from, to) => took.push([from, to]) },
    "../onboarding/api": { store },
    "../shell/tab-store": { HOME: "@home", CHAT: "chat", setHomeTabs: () => {}, isRef: () => false, tabsSettled: async () => ({ tabs: [] }), takeTabs: (...args) => took.push(args) },
  });
  assert.equal(draftKey(), "@home");
  newSession("p");
  setHomeDraft({ model: { provider: "fake", model: "m" } });
  const left = useHomeDraft();
  newChat();
  assert.equal(useHomeDraft(), left, "on a draft, New chat changes nothing");
  newSession(null);
  assert.equal(draftKey(), "@home");
  assert.equal(useHomeDraft().model, null, "Chats' draft has its own model");
  newSession("p");
  window.location.hash = "#settings/general";
  newChat();
  assert.equal(draftKey(), "@home:p");
  assert.equal(useHomeDraft().model.model, "m");
  assert.equal(window.location.hash, "");
  setHomeDraft({ review: "github.com/o/r#1" });
  setHomeDraft({ review: undefined });
  assert.equal(draftKey(), "@home:p", "the review chat's draft gives p's back");
  await pickHomeProject("full");
  assert.equal(draftKey(), "@home:full");
  assert.deepEqual(took, [], "a draft with words of its own takes nothing");
});
