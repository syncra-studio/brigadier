// Mockup only: the app itself on a fake daemon with the mockup's agents: a session, New chat and Settings. A pick moves
// the session's row as Rust does.
import type { Row } from "../src/daemon";
import type { Item, Session } from "../src/thread/item";
import { groups } from "./model-picker-fake";

const now = Date.now();
const id = "live";
const items = [
  { id: "u", turnId: "t1", kind: "message", role: "user", text: "Why does the tab test fail now and then?", streaming: false, sentAt: now, n: 1 },
  { id: "a", turnId: "t1", kind: "message", role: "assistant", text: "It reads the strip before the closing tab has gone. It now waits for that.", streaming: false, final: true, sentAt: now, n: 2 },
] as unknown as Item[];
const row = {
  id, title: "Flaky tab test", state: "idle", reason: null, mark: null, resets: null, sent: now, finished: now, project: null, backend: "claude", updated: now, items: 2, error: null,
  model: "opus", effort: "high", fast: true, levels: ["ask", "auto", "full"], level: "auto", running: false,
} as unknown as Row & Record<string, unknown>;
const session = { id, title: row.title, n: 1, before: null, turns: [{ id: "t1", status: "done", startedAt: now, endedAt: now + 40_000, backend: "claude" }], items, questions: [], approvals: [] } as unknown as Session & { n: number };

const GROUPS = groups("sign-in").map((group) => ({
  ...group,
  levels: ["ask", "auto", "full"],
  level: "auto",
  held: false,
  models: group.models.map(({ defaultEffort, ...model }) => ({ ...model, default_effort: defaultEffort ?? null })),
}));
const FORK = { worktree: null, default: "chat", agent: "claude", fingerprint: "f" };
const replies: Record<string, object> = {
  profile: { name: "", onboarded: true, intro_seen: true, tour_seen: true, agents: [], git_writer: { backend: "claude", model: "haiku" } },
  models: { groups: GROUPS },
  commands: { commands: [] },
  fork: FORK,
};

function daemon() {
  const { port1, port2 } = new MessageChannel();
  let n = 0;
  const say = (frame: object) => {
    const json = new TextEncoder().encode(JSON.stringify(frame));
    const out = new Uint8Array(4 + json.length);
    new DataView(out.buffer).setUint32(0, json.length);
    out.set(json, 4);
    port2.postMessage(out);
  };
  port2.onmessage = ({ data }: MessageEvent<Uint8Array>) => {
    const { id: re, op, args = [], session: asked } = JSON.parse(new TextDecoder().decode(data.subarray(4)));
    if (op === "subscribe") return say({ re, ok: true, n, rows: [row], projects: [] });
    if (op === "thread" || op === "peek") return say(asked === id ? { re, ok: true, n: session.n, session } : { re, ok: false, error: "not_found" });
    if (op !== "run") return;
    const command = args[0] as string;
    const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
    if (command === "set" && flag("--model")) {
      say({ re, ok: true });
      Object.assign(row, { backend: flag("--agent"), model: flag("--model"), effort: flag("--effort"), fast: args.includes("--fast"), setup_op: flag("--op") });
      return say({ n: ++n, rows: [row], gone: [] });
    }
    const reply = replies[command];
    say(reply ? { re, ok: true, ...reply } : { re, ok: false, message: "Not in this mockup" });
  };
  window.postMessage("daemon-port", "*", [port1]);
  say({ status: "running", pid: 1, version: "mockup", build: 0 });
}

/** Opens the app on it, at the session unless another place is asked for. */
export async function openReal() {
  if (!location.hash || location.hash === "#") location.hash = `#thread/${id}`;
  daemon();
  await import("../src/main");
}
