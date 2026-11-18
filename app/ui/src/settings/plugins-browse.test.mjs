import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as jsx from "react/jsx-runtime";
import { moduleRunnerTransform, transformWithOxc } from "vite";

const source = readFileSync(new URL("./plugins-browse.tsx", import.meta.url), "utf8");
const transformed = await transformWithOxc(source, "plugins-browse.tsx", { jsx: { runtime: "automatic" } });
const { code } = await moduleRunnerTransform(transformed.code, null, "plugins-browse.tsx", source);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const catalog = JSON.parse(readFileSync(new URL("../../../../crates/cli/src/plugins/catalog.json", import.meta.url), "utf8"));

// Render the search with its registry request settled; visual dependencies stay as element types.
async function results(asked, { items = [], found = [], onOpen = () => {} } = {}) {
  let state = 0;
  const exports = {};
  const require = (id) => {
    if (id === "react/jsx-runtime") return jsx;
    if (id === "react") return { useEffect() {}, useState: () => [state++ === 0 ? found : null, () => {}] };
    return new Proxy({}, { get: (_, name) => name === "then" ? undefined : () => null });
  };
  await new AsyncFunction("__vite_ssr_import__", "__vite_ssr_exportName__", code)(require, (name, get) => Object.defineProperty(exports, name, { get }));
  const page = exports.SearchResults({ value: { catalog, items, own: [] }, asked, remote: true, onOpen, onEntry: {} });
  const grid = page.props.children[0];
  return grid.type === exports.PickGrid ? grid.props.children : [];
}

test("phrases and hyphenated names match at word starts", async () => {
  for (const query of ["React Best", "react-best-practices", "best pract", "  REACT--BEST  "]) {
    assert.ok((await results(query)).some((row) => row.props.name === "React Best Practices"), query);
  }
  assert.equal((await results("act Best")).length, 0);
  assert.equal((await results("rea", { items: [{ key: "create", name: "Create" }] })).some((row) => row.props.name === "Create"), false);
});

test("an installed bundled skill stays findable and opens by its key", async () => {
  let opened;
  const skill = { key: "skill:capture", kind: "skill", name: "notion-knowledge-capture", with: "notion", catalog: "notion", description: "Capture knowledge", detail: "/skills/capture" };
  const rows = await results("capture", { items: [skill], onOpen: (key) => { opened = key; } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].props.name, skill.name);
  assert.equal(rows[0].props.end.props.children, "Installed");
  rows[0].props.onOpen();
  assert.equal(opened, skill.key);
});

test("registry results identified by Rust as catalog servers appear only once", async () => {
  const linear = { key: "app.linear/linear", kind: "server", name: "Linear", publisher: "linear.app", mark: "mcp.linear.app", catalog: "linear", form: { remote: true, url: "https://mcp.linear.app/mcp" } };
  assert.equal((await results("linear", { found: [linear] })).length, 1);
  assert.equal((await results("linear", { found: [{ ...linear, catalog: null }] })).length, 2);
});
