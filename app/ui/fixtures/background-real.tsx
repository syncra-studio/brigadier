// Mockup only: the app itself on a stub daemon that hands it the fixture page's session, workers and processes, stops
// them as asked and refuses the rest, so the real summary card shows beside background.html's. Not the app.
// Loaded first, so it hears the port below.
import "../src/daemon";
import type { Job, Row } from "../src/daemon";

const NOW = Date.now();
const MIN = 60_000;
const LEAD = "mockup";
const job = (pid: number, label: string, ago: number): Job => ({ pid, label, start_us: (NOW - ago * MIN) * 1000 });
const row = (id: string, title: string, background: Job[], extra: Partial<Row> = {}): Row => ({
  id, title, state: "idle", reason: null, mark: null, resets: null, sent: NOW - 8 * MIN, finished: NOW - 7 * MIN, project: "p1", backend: "claude", updated: NOW - 7 * MIN, items: 2, error: null, background, background_ran: background.length > 0, ...extra,
});
const worker = (kind: NonNullable<Row["worker"]>["kind"], word: string, started: number, ended?: number): Pick<Row, "worker"> => ({
  worker: { parent: LEAD, root: LEAD, depth: 1, brief: "", started: NOW - started * MIN, kind, word, ended: ended === undefined ? null : NOW - ended * MIN, model: "", receipt: "" },
});
const PROJECTS = [{ id: "p1", name: "brigadier", folder: "/Users/me/code/brigadier", trusted: true, setup: "", include: [], added: NOW }];
let rows: Row[] = [
  row(LEAD, "Fix the tab test", [job(4101, "cargo watch -x check", 26)]),
  row("w1", "Fix the flaky tab test", [job(4102, "pnpm vite app/ui --port 5188", 4)], worker("working", "Working", 6)),
  row("w2", "Mockup: sidebar fill", [job(4103, "pnpm vite app/ui --port 5201", 52)], worker("needsYou", "Waiting for your notes", 58)),
  row("w3", "Redraw the settings rows", [job(4104, "node_modules/.bin/vite app/ui --port 5174", 671)], worker("done", "Done", 700, 640)),
  row("w4", "Review the merge", [job(4105, "target/debug/brigadier-host --test", 166), job(4106, "target/debug/brigadierd", 165)], worker("done", "Done", 190, 125)),
];
const GIT = {
  head: { branch: "fix-the-tab-test", head: "0b4d5d3", upstream: null, ahead: 0, behind: 0, checkout: "worktree", remote: null },
  files: [{ path: "app/ui/src/shell/tab-views.tsx", old: null, staged: null, changes: "M" }],
};
const THREAD = { id: LEAD, title: "Fix the tab test", before: null, after: null, turns: [], items: [], work: [] };

const { port1, port2 } = new MessageChannel();
const say = (frame: object) => {
  const json = new TextEncoder().encode(JSON.stringify(frame));
  const out = new Uint8Array(4 + json.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  port2.postMessage(out);
};
let n = 1;
port2.onmessage = ({ data }: MessageEvent<Uint8Array>) => {
  const { id, op, args = [] } = JSON.parse(new TextDecoder().decode(data.subarray(4))) as { id: number; op: string; args?: string[] };
  const [command, target, verb, pid] = args;
  if (op === "subscribe") say({ re: id, n, projects: PROJECTS, rows });
  else if (op === "thread" || op === "peek") say({ re: id, ok: true, n: 1, session: THREAD });
  else if (op === "git") say({ re: id, ok: true, n: 1, git: GIT });
  else if (command === "profile") say({ re: id, ok: true, onboarded: true, intro_seen: true, agents: [] });
  else if (command === "attach") say({ re: id, ok: true, files: [] });
  else if (command === "source" && verb === "review") say({ re: id, ok: true, review: { files: [{ path: GIT.files[0]!.path, insertions: 41, deletions: 12 }] } });
  else if (command === "jobs" && verb === "stop") {
    rows = rows.map((each) => (each.id === target ? { ...each, background: each.background!.filter((one) => one.pid !== Number(pid)) } : each));
    say({ re: id, ok: true });
    say({ n: ++n, rows: rows.filter((each) => each.id === target), gone: [] });
  } else say({ re: id, ok: false, error: "not in this mockup", message: "Not in this mockup" });
};

localStorage.setItem("sidebar.open", "false");
location.hash = `#thread/${LEAD}`;
window.postMessage("daemon-port", "*", [port1]);
say({ status: "running", pid: 1, version: "mockup", build: 0 });
void import("../src/main").then(async () => {
  const { toggleSummary } = await import("../src/shell/summary-card");
  // In a pane too narrow to pin the card, it opens over the thread, as its toggle does.
  const timer = setInterval(() => {
    const layout = document.querySelector<HTMLElement>("[data-summary]")?.dataset.summary;
    if (!layout) return;
    clearInterval(timer);
    if (layout === "float") toggleSummary();
  }, 100);
});
