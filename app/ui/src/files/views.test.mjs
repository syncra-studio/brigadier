import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { moduleRunnerTransform, transformWithOxc } from "vite";

// Loads views.tsx with every import inert (as shell/tabs.test.mjs does): only `over` is tested.
const stub = () => new Proxy(function () {}, { get: (_, name) => (name === "then" ? undefined : stub()), apply: () => stub() });
const file = "./views.tsx";
const source = readFileSync(new URL(file, import.meta.url), "utf8");
const { code } = await moduleRunnerTransform((await transformWithOxc(source, file)).code, null, file, source);
const views = {};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
await new AsyncFunction("__vite_ssr_import__", "__vite_ssr_exportName__", code)(() => stub(), (name, get) => Object.defineProperty(views, name, { get }));

const read = (repos, files, marks = {}) => ({ list: { repos, files, ignored: [], truncated: false }, marks: { files: marks, folders: {} } });
const REPOS = ["a", "a-b", "group/c"];

test("a read of the open repos keeps the others' last read [D892]", () => {
  const last = read(REPOS, ["a/x", "a-b/y", "group/c/z"], { "a/x": "modified", "a-b/y": "added" });
  const next = read(REPOS, ["a/x2"], { "a/x2": "added" });
  const got = views.over(last, next, ["a"]);
  assert.deepEqual(got.list.files.toSorted(), ["a-b/y", "a/x2", "group/c/z"]);
  assert.deepEqual(got.marks.files, { "a-b/y": "added", "a/x2": "added" });
});

test("nothing asked keeps every repo's last read", () => {
  const last = read(REPOS, ["a/x", "group/c/z"]);
  assert.deepEqual(views.over(last, read(REPOS, []), []).list.files, ["a/x", "group/c/z"]);
});

test("a changed set of repos, no last read or a plain checkout is the read itself", () => {
  const next = read(["a"], ["a/x"]);
  assert.equal(views.over(read(REPOS, ["a-b/y"]), next, ["a"]), next);
  assert.equal(views.over(undefined, next, ["a"]), next);
  const plain = { list: { files: ["x"], ignored: [], truncated: false }, marks: { files: {}, folders: {} } };
  assert.equal(views.over(read(REPOS, ["a/x"]), plain, []), plain);
});
