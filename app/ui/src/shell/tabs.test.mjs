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

test("New chat is one draft, back as it was left; a project's New chat is that project's own [D282]", async () => {
  const closed = [];
  globalThis.window = { location: { hash: "" } };
  const store = (value) => ({ get: () => value, set: (next) => (value = next), use: () => value });
  const { draftKey, useHomeDraft, setHomeDraft, newSession, newChat, pickHomeProject } = await load("../home/start.ts", {
    "../session/draft": { HOME_DRAFT: "@home", keepDraft: () => {}, keepProject: () => {}, projectOf: () => undefined },
    "../onboarding/api": { store },
    "../shell/tab-store": { CHAT: "chat", selectTab: () => {}, closeOthers: (owner, keep) => closed.push([owner, keep]) },
  });
  pickHomeProject("p", null);
  assert.deepEqual(closed, [["@home", "chat"]], "another project closes New chat's tabs but Chat");
  pickHomeProject("p", "p");
  assert.equal(closed.length, 1, "the same project again leaves them");
  const left = useHomeDraft();
  newChat();
  assert.equal(useHomeDraft(), left, "on New chat already, New chat changes nothing");
  newSession("q");
  assert.equal(draftKey(), "@home:q", "a project's New chat is its own draft");
  window.location.hash = "#settings/general";
  newChat();
  assert.equal(draftKey(), "@home");
  assert.equal(useHomeDraft().project, "p", "New chat comes back in the project it was left in");
  assert.equal(useHomeDraft().chat, false);
  assert.equal(window.location.hash, "");
  setHomeDraft({ model: { provider: "fake", model: "m" } });
  newSession("q");
  assert.equal(useHomeDraft().model, null, "q's draft kept its own model");
  setHomeDraft({ review: "github.com/o/r#1" });
  setHomeDraft({ review: undefined });
  assert.equal(draftKey(), "@home:q", "the review chat's draft gives q's back");
  assert.equal(useHomeDraft().project, "q");
  pickHomeProject(null, "q");
  assert.equal(closed.length, 1, "a project's own draft never closes New chat's tabs");
});

test("A project's own draft picks another project's draft, or No project New chat's, each as it was left [D330]", async () => {
  const closed = [];
  globalThis.window = { location: { hash: "" } };
  const store = (value) => ({ get: () => value, set: (next) => (value = next), use: () => value });
  const { draftKey, useHomeDraft, setHomeDraft, newSession, pickHomeProject } = await load("../home/start.ts", {
    "../session/draft": { HOME_DRAFT: "@home", keepDraft: () => {}, keepProject: () => {}, projectOf: () => undefined },
    "../onboarding/api": { store },
    "../shell/tab-store": { CHAT: "chat", selectTab: () => {}, closeOthers: (owner, keep) => closed.push([owner, keep]) },
  });
  setHomeDraft({ chat: true });
  newSession("p");
  setHomeDraft({ model: { provider: "fake", model: "p's" } });
  pickHomeProject("q", "p");
  assert.equal(draftKey(), "@home:q", "another project opens its own draft");
  assert.equal(useHomeDraft().project, "q");
  setHomeDraft({ model: { provider: "fake", model: "q's" } });
  pickHomeProject("p", "q");
  assert.equal(useHomeDraft().model.model, "p's", "p's draft comes back as it was left");
  pickHomeProject(null, "p");
  assert.equal(draftKey(), "@home", "No project opens New chat's draft");
  assert.equal(useHomeDraft().chat, true, "as it was left");
  assert.equal(closed.length, 0, "no draft's tabs close on a switch");
});

test("New chat's project is kept with its words, past a send and a relaunch [D284]", async () => {
  const written = [];
  const timers = globalThis.setTimeout;
  globalThis.setTimeout = (run) => (run(), 0);
  const empty = { parts: [], attachmentIds: [] };
  const isEmpty = (d) => d.attachmentIds.length === 0 && d.parts.every((p) => typeof p === "string" && p.trim() === "");
  const run = async (args) => (written.push(args), { ok: true, draft: JSON.stringify({ parts: ["hi"], attachmentIds: [], project: "p" }) });
  const fresh = () => load("../session/draft.ts", { "../components/composer/draft": { EMPTY_DRAFT: empty, isEmpty } });
  let { keepDraft, keepProject, projectOf, loadDraft } = await fresh();
  const settle = () => new Promise((r) => setImmediate(r));
  keepProject(run, "@home", "p");
  keepDraft(run, "@home", { parts: ["words"], attachmentIds: [] });
  await settle();
  assert.deepEqual(JSON.parse(written.at(-1)[2]), { parts: ["words"], attachmentIds: [], project: "p" }, "typing keeps the project");
  keepDraft(run, "@home", empty);
  await settle();
  assert.equal(JSON.parse(written.at(-1)[2]).project, "p", "a send empties the words, not the project");
  keepDraft(run, "@session", empty);
  await settle();
  assert.equal(written.at(-1)[2], "", "a draft with no project still goes when emptied");
  ({ projectOf, loadDraft } = await fresh());
  assert.deepEqual(await loadDraft(run, "@home"), { parts: ["hi"], attachmentIds: [], project: "p" });
  assert.equal(projectOf("@home"), "p", "a relaunch reads it back");
  globalThis.setTimeout = timers;
});
