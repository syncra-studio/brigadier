// Mockup only: the app itself on a fake daemon, with a session at each of Overnight's moments. The first is live: its
// pill, its questions, Start night and the way back move its state as Rust will.
import type { Row } from "../src/daemon";
import type { Overnight } from "../src/sessions/overnight";
import type { Item, Session } from "../src/thread/item";
import { DECIDED, DONE, NOT_DONE, PLAN, QUESTIONS, RESEARCH, TASK, TITLE } from "./overnight-parts";

type Fake = { row: Row & Record<string, unknown>; session: Session & { n: number } };
const HOUR = 3_600_000;
const now = Date.now();

const READY: Overnight = { state: "ready", words: "Full access until you’re back. Nothing is pushed or merged. I research, build, and have it reviewed until a round finds nothing." };
const started = (at: number): Item => ({ id: "started", turnId: "t1", kind: "overnight", moment: "started", at });
const report: Item = {
  id: "report", turnId: "t1", kind: "overnight", moment: "report", at: now, ms: 7.4 * HOUR,
  summary: "Export works and is ready to review. PDF isn’t done.",
  facts: ["+612 −88 in 14 files", RESEARCH],
  url: "http://localhost:5317/",
  done: DONE, left: [NOT_DONE], decided: DECIDED,
};
const user = (id: string): Item => ({ id, turnId: "t1", kind: "message", role: "user", text: TASK, streaming: false, sentAt: now - 8 * HOUR });
const says = (id: string): Item => ({ id, turnId: "t1", kind: "message", role: "assistant", text: PLAN, streaming: false, final: true, sentAt: now - 8 * HOUR });

function fake(id: string, title: string, overnight: Overnight | null, items: Item[], questions = false): Fake {
  const level = overnight?.state === "night" ? "full" : "auto";
  const row = {
    id, title, state: "idle", reason: null, mark: null, resets: null, sent: now, finished: now, project: null, backend: "claude", updated: now, items: 2, error: null,
    model: "opus", effort: "high", levels: ["ask", "auto", "full"], level, overnight, steer: true, running: false,
  } as unknown as Fake["row"];
  const all = [user(`${id}-u`), says(`${id}-a`), ...items].map((item, at) => ({ ...item, n: at + 1 }));
  const session = { id, title, n: 1, before: null, turns: [{ id: "t1", status: "done", startedAt: now - 8 * HOUR, endedAt: now - 8 * HOUR + 40_000, backend: "claude" }], items: all, questions: questions ? [QUESTIONS] : [], approvals: [] } as Fake["session"];
  return { row, session };
}

const night: Overnight = { state: "night", since: now - 3.3 * HOUR, done: 3, total: 4, decided: 2 };
const fakes = new Map(
  [
    fake("live", TITLE, null, []),
    fake("asking", "Asking its last questions", { state: "asking" }, [], true),
    fake("ready", "Ready for the night", READY, []),
    fake("night", "In its night", night, [started(night.since!)]),
    fake("morning", "Morning", null, [started(now - 7.4 * HOUR), report]),
  ].map((each) => [each.row.id, each]),
);

function daemon() {
  const { port1, port2 } = new MessageChannel();
  let n = 0;
  let watch = 0;
  let open = "";
  const say = (frame: object) => {
    const json = new TextEncoder().encode(JSON.stringify(frame));
    const out = new Uint8Array(4 + json.length);
    new DataView(out.buffer).setUint32(0, json.length);
    out.set(json, 4);
    port2.postMessage(out);
  };
  const row = (id: string, change: object) => {
    const one = fakes.get(id)!;
    Object.assign(one.row, change);
    say({ n: ++n, rows: [one.row], gone: [] });
  };
  const thread = (id: string, items: Item[], questions: Session["questions"] = []) => {
    const { session } = fakes.get(id)!;
    const put = items.map((item) => ({ ...item, n: session.items.find((each) => each.id === item.id)?.n ?? session.items.length + 1 + items.indexOf(item) }));
    for (const item of put) {
      const at = session.items.findIndex((each) => each.id === item.id);
      if (at < 0) session.items.push(item);
      else session.items[at] = item;
    }
    session.questions = questions;
    session.n++;
    if (open === id) say({ thread: id, watch, n: session.n, items: put, turns: [], work: [], questions });
  };
  const act = (id: string, what: string, op: string | undefined) => {
    const one = fakes.get(id)!;
    const at = Date.now();
    const was = one.row.overnight;
    const state: Overnight | null = what === "off" ? null : what === "start" ? { state: "night", since: at, done: 0, total: 4, decided: 0 } : { state: "asking" };
    row(id, { overnight: state, overnight_op: op, level: what === "start" ? "full" : "auto" });
    if (what === "on") thread(id, [], [QUESTIONS]);
    if (what === "start") thread(id, [started(at)]);
    if (what === "off") thread(id, was?.state === "night" ? [{ ...report, at, ms: at - (was.since ?? at) } as Item] : [], []);
  };
  const answer = (id: string) => {
    row(id, { overnight: READY });
    thread(id, []);
  };
  const MODELS = [{ provider: "claude", label: "Claude", models: [{ id: "opus", label: "Opus 5.5", efforts: ["high"], defaultEffort: "high" }], levels: ["ask", "auto", "full"], level: "auto", held: false }];
  const replies: Record<string, object> = {
    profile: { name: "", onboarded: true, intro_seen: true, tour_seen: true, agents: [] },
    models: { groups: MODELS },
    commands: { commands: [] },
  };
  port2.onmessage = ({ data }: MessageEvent<Uint8Array>) => {
    const { id: re, op, args = [], session } = JSON.parse(new TextDecoder().decode(data.subarray(4)));
    if (op === "subscribe") return say({ re, ok: true, n, rows: [...fakes.values()].map((each) => each.row), projects: [] });
    if (op === "thread" || op === "peek") {
      const one = fakes.get(session);
      if (!one) return say({ re, ok: false, error: "not_found" });
      if (op === "thread") [watch, open] = [re, session];
      return say({ re, ok: true, n: one.session.n, session: one.session });
    }
    if (op !== "run") return;
    const [command, id, what, flag, value] = args as string[];
    if (command === "overnight") {
      say({ re, ok: true });
      return act(id!, what!, flag === "--op" ? value : undefined);
    }
    if (command === "answer") {
      say({ re, ok: true, result: "delivered" });
      return answer(id!);
    }
    const reply = replies[command!];
    say(reply ? { re, ok: true, ...reply } : { re, ok: false, message: "Not in this mockup" });
  };
  window.postMessage("daemon-port", "*", [port1]);
  say({ status: "running", pid: 1, version: "mockup", build: 0 });
}

/** Opens the app on it, at `#thread/<session>` (the live one unless another is asked for) or New chat. */
export async function openReal() {
  if (!location.hash || location.hash === "#") location.hash = "#thread/live";
  daemon();
  await import("../src/main");
}
