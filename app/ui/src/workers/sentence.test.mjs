import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { moduleRunnerTransform, transformWithOxc } from "vite";

// Loads a .tsx with every import inert but the ones given (as files/views.test.mjs does).
const stub = () => new Proxy(function () {}, { get: (_, name) => (name === "then" ? undefined : stub()), apply: () => stub() });
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function load(file, given = {}) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const { code } = await moduleRunnerTransform((await transformWithOxc(source, file)).code, null, file, source);
  const out = {};
  await new AsyncFunction("__vite_ssr_import__", "__vite_ssr_exportName__", code)((url) => given[url] ?? stub(), (name, get) => Object.defineProperty(out, name, { get }));
  return out;
}
const { batchWords } = await load("./sentence.tsx", { "./chip": await load("./chip.tsx") });
const w = (kind) => ({ id: kind, name: kind, kind, word: kind });

test("a worker's End has its own row, so its start row keeps its start [D328]", () => {
  assert.equal(batchWords([w("stopped")], true), "started working");
  assert.equal(batchWords([w("stopped"), w("done")], true), "finished");
});

test("a subagent cancelled, with no row of its own, reads stopped", () => {
  assert.equal(batchWords([w("stopped")]), "stopped");
  assert.equal(batchWords([w("working"), w("stopped")]), "started working");
});
