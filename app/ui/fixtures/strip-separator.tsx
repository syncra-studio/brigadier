// Mockup only: the folded sidebar's separator between New chat and the first tab, the short rule (variant A, ?v=a), now
// the app's own: four windows, tabs open and the chat alone, the right panel closed and open. ?v=real is one window: the
// whole app on a stub daemon with fake sessions, files and tabs (?tabs, ?panel, ?front its state). ?v=e and ?v=f are round
// 3's A and B on the same four windows, their rules over the app's own (strip-separator.css). Not the app.
import "../src/theme.css";
import "./fixtures.css";
import "./strip-separator.css";
// Listening for the daemon's port before it is posted.
import "../src/daemon";

import { createRoot } from "react-dom/client";

import type { Tab } from "../src/shell/tab-store";

const query = new URLSearchParams(location.search);
const variant = query.get("v") ?? "a";
/** A variant's window, the app's own rules or round 3's over them. */
const page = variant === "e" || variant === "f" ? `?v=${variant}&window` : "?v=real";

const NOW = Date.now();
const MIN = 60_000;
const PROJECTS = [
  { id: "p1", name: "brigadier", folder: "/Users/me/code/brigadier" },
  { id: "p2", name: "website", folder: "/Users/me/code/website" },
  { id: "p3", name: "notes", folder: "/Users/me/notes" },
].map((project, at) => ({ ...project, trusted: true, setup: "", include: [], added: NOW - (3 - at) * 86_400_000 }));
const ROWS = [
  ["s1", "Fix the flaky tab test", "p1", 2],
  ["s2", "Rename the settings rows", "p1", 40],
  ["s3", "New pricing page", "p2", 25],
  ["s4", "Weekly review", "p3", 900],
].map(([id, title, project, ago]) => {
  const at = NOW - Number(ago) * MIN;
  return { id, title, project, state: "idle", mark: null, resets: null, sent: at, finished: at, updated: at, backend: "claude", items: 2, error: null };
});
const SESSION = {
  id: "s1",
  title: "Fix the flaky tab test",
  before: null,
  turns: [{ id: "t1", status: "done", startedAt: NOW - 3 * MIN, endedAt: NOW - 2 * MIN }],
  items: [
    { id: "i1", turnId: "t1", n: 1, kind: "message", role: "user", text: "Why does the tab test fail now and then?", streaming: false, sentAt: NOW - 3 * MIN },
    { id: "i2", turnId: "t1", n: 2, kind: "message", role: "assistant", text: "It reads the strip before the closing tab has gone. It now waits for that.", streaming: false, final: true },
  ],
  work: [],
};
const FILES = { files: ["README.md", "package.json", "src/app.ts", "src/tabs.ts", "src/theme.css"], truncated: false, ignored: [] };
const TABS: Tab[] = [
  { id: "t-1", kind: "file", opener: "chat", target: "src/tabs.ts" },
  { id: "t-2", kind: "new", opener: "chat" },
  { id: "t-3", kind: "file", opener: "chat", target: "README.md" },
];

/** What main hands the page in the app: a port to the daemon, here one that answers with the fakes and refuses the rest. */
function fakeDaemon() {
  const { port1, port2 } = new MessageChannel();
  let rev = 1;
  const panel = { open: query.has("panel"), width: 240 };
  const front = query.get("front") ?? "chat";
  const say = (frame: object) => {
    const json = new TextEncoder().encode(JSON.stringify(frame));
    const out = new Uint8Array(4 + json.length);
    new DataView(out.buffer).setUint32(0, json.length);
    out.set(json, 4);
    port2.postMessage(out);
  };
  const run = ([op, ...args]: string[]): object | null => {
    if (op === "profile") return { onboarded: true, intro_seen: true, agents: [] };
    if (op === "panel") {
      if (args[0] === "open") panel.open = args[1] === "on";
      if (args[0] === "width") panel.width = Number(args[1]);
      return { rev: rev++, ...panel };
    }
    if (op === "tabs") return tabs(args[0]!, args.slice(1));
    if (op === "source" && args.includes("files")) return { list: { ...FILES, marks: { files: {}, folders: {} } } };
    if (op === "source" && args.includes("file")) return { file: { size: 40, text: "// A fake file in this mockup.\n", truncated: false } };
    return null;
  };
  const state = new Map([["s1", query.has("tabs") ? { tabs: TABS, active: front } : { tabs: [] as Tab[], active: "chat" }]]);
  /** The tab changes as Rust makes them, for what the tab bar, Files and a New tab ask (tab-store.ts). */
  const tabs = (owner: string, [op, id = "", ...rest]: string[]) => {
    const now = state.get(owner) ?? { tabs: [], active: "chat" };
    const at = now.tabs.findIndex((tab) => tab.id === id);
    const add = (tab: Tab, same?: Tab) => {
      if (!same) now.tabs = now.tabs.toSpliced(now.tabs.findIndex((each) => each.id === now.active) + 1, 0, tab);
      now.active = (same ?? tab).id;
    };
    const isFile = (path?: string) => (tab: Tab) => tab.kind === "file" && tab.target === path;
    if (op === "select") now.active = id;
    if (op === "open") add({ id, kind: rest[0] as Tab["kind"], opener: now.active, target: rest[1] }, rest[0] === "file" ? now.tabs.find(isFile(rest[1])) : undefined);
    if (op === "replace") now.tabs = now.tabs.map((tab) => (tab.id === id ? { ...tab, kind: rest[0] as Tab["kind"], target: rest[1] } : tab));
    if (op === "file") {
      const preview = rest[2] === "preview";
      const open = now.tabs.find(isFile(rest[0]));
      const old = preview && !open ? now.tabs.find((tab) => tab.preview) : undefined;
      if (open && !preview) now.tabs = now.tabs.map((tab) => (tab === open ? { ...tab, preview: false } : tab));
      if (old) now.tabs = now.tabs.map((tab) => (tab === old ? { ...tab, target: rest[0] } : tab));
      add({ id, kind: "file", opener: now.active, target: rest[0], preview }, open ?? old);
    }
    if (op === "keep") now.tabs = now.tabs.map((tab) => (tab.id === id ? { ...tab, preview: false } : tab));
    if (op === "move" && at >= 0) now.tabs = now.tabs.toSpliced(at, 1).toSpliced(Number(rest[0]), 0, now.tabs[at]!);
    if (op === "close" && at >= 0) {
      const { opener } = now.tabs[at]!;
      now.tabs = now.tabs.toSpliced(at, 1);
      if (now.active === id) now.active = now.tabs.some((tab) => tab.id === opener) ? opener : opener === "chat" ? "chat" : (now.tabs[at]?.id ?? now.tabs[at - 1]?.id ?? "chat");
    }
    if (op === "close-others") now.tabs = now.tabs.filter((tab) => tab.id === id);
    if (op === "close-right") now.tabs = now.tabs.slice(0, at + 1);
    if (now.active !== "chat" && !now.tabs.some((tab) => tab.id === now.active)) now.active = "chat";
    state.set(owner, now);
    return { rev: rev++, ...now };
  };
  port2.onmessage = ({ data }: MessageEvent<Uint8Array>) => {
    const { id, op, args = [], session } = JSON.parse(new TextDecoder().decode(data.subarray(4)));
    if (op === "subscribe") say({ re: id, n: 1, projects: PROJECTS, rows: ROWS });
    else if (op === "thread" && session) say({ re: id, ok: true, n: 1, session: { ...SESSION, id: session } });
    else if (op === "git") say({ re: id, ok: true, n: 1, git: { head: { branch: "main", oid: "0000000" }, files: [] } });
    else {
      const reply = op === "run" ? run(args) : null;
      say(reply ? { re: id, ok: true, ...reply } : { re: id, ok: false, error: "not in this mockup", message: "Not in this mockup" });
    }
  };
  window.postMessage("daemon-port", "*", [port1]);
  say({ status: "running", pid: 1, version: "mockup", build: 0 });
}

const STATES = [
  ["Tabs open, right panel closed", "tabs&front=t-1"],
  ["Tabs open, right panel open", "tabs&panel"],
  ["Chat alone, right panel closed", ""],
  ["Chat alone, right panel open", "panel"],
] as const;

if (variant === "real" || query.has("window")) {
  document.documentElement.dataset.mockup = variant;
  // The sidebar folded, as each window starts.
  localStorage.setItem("sidebar.open", "false");
  location.hash = "#thread/s1";
  document.body.insertAdjacentHTML("beforeend", '<div aria-hidden="true" class="pointer-events-none fixed start-4 top-4.25 z-30 flex gap-2"><i class="size-3 rounded-full bg-destructive"></i><i class="size-3 rounded-full bg-warning"></i><i class="size-3 rounded-full bg-success"></i></div>');
  fakeDaemon();
  void import("../src/main");
} else if (!["a", "e", "f"].includes(variant))
  createRoot(document.getElementById("root")!).render(<p className="p-4 text-label">This variant was dropped. Its round keeps its screenshot.</p>);
else
  createRoot(document.getElementById("root")!).render(
    // Each never narrower than an app window: a narrow column scrolls sideways, the window's left edge first.
    <main className="flex min-h-screen w-full min-w-max flex-col gap-4 bg-muted p-4">
      {STATES.map(([name, state]) => (
        <figure key={name} className="flex min-h-56 min-w-184 flex-1 flex-col gap-1.5">
          <figcaption className="text-label">{name}</figcaption>
          <iframe className="w-full flex-1 rounded-lg" title={name} aria-label={name} src={`${page}&${state}`} />
        </figure>
      ))}
    </main>,
  );
