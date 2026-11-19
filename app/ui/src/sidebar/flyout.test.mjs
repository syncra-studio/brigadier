import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { moduleRunnerTransform, transformWithOxc } from "vite";

const source = readFileSync(new URL("./flyout.tsx", import.meta.url), "utf8");
const transformed = await transformWithOxc(source, "flyout.tsx", { jsx: { runtime: "automatic" } });
const { code } = await moduleRunnerTransform(transformed.code, null, "flyout.tsx", source);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const exports = {};
// Imports stay stubs: only the pure attention rule runs.
const stub = () => new Proxy({}, { get: (_, name) => (name === "then" ? undefined : () => null) });
await new AsyncFunction("__vite_ssr_import__", "__vite_ssr_exportName__", code)(stub, (name, get) => Object.defineProperty(exports, name, { get }));
const { attentionOf } = exports;
const row = (id, mark) => ({ id, mark });

test("one mark for every attention kind [D844]", () => {
  for (const mark of ["needs", "amber", "unread"]) assert.equal(attentionOf([row("a", null), row("b", mark)], null), true, mark);
});

test("no mark for working, background or nothing", () => {
  assert.equal(attentionOf([row("a", "working"), row("b", "background"), row("c", null)], null), false);
  assert.equal(attentionOf([], null), false);
});

test("the open session's own mark doesn't count", () => {
  assert.equal(attentionOf([row("a", "needs")], "a"), false);
  assert.equal(attentionOf([row("a", "needs"), row("b", "amber")], "a"), true);
});
