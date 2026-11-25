// Mockup only: the app itself on a fake daemon, at Settings › Storage, with the mockup's numbers.
import { type Counted, type Holder, PER_CHAT } from "../src/settings/storage-data";
import { BROWSER, CHATS_SHOWN, free, measure } from "./storage-data";

const replies: Record<string, object> = {
  profile: { name: "", onboarded: true, intro_seen: true, tour_seen: true, agents: [] },
  models: { groups: [] },
  commands: { commands: [] },
};
const DELAY: Record<string, number> = { build: 1800, worktrees: 1200, temp: 500, history: 800, browser: 300 };
const holders = CHATS_SHOWN.flatMap((chat): Holder[] => [chat, ...chat.workers]);
const sizes: Counted["sizes"] = Object.fromEntries(PER_CHAT.map((kind) => [kind, measure(kind)]));

function storage([, what, group, id]: string[]): object {
  if (!what) return { free: free(sizes), chats: CHATS_SHOWN };
  if (what === "browser") return { total: BROWSER };
  if (what !== "free") return { sizes: { ...sizes[what as (typeof PER_CHAT)[number]] } };
  const goes = holders.find((each) => each.id === id)?.goes ?? {};
  const went = PER_CHAT.filter((kind) => goes[kind] === group);
  for (const kind of went) sizes[kind]![id!] = 0;
  return { went };
}

function daemon() {
  const { port1, port2 } = new MessageChannel();
  const say = (frame: object) => {
    const json = new TextEncoder().encode(JSON.stringify(frame));
    const out = new Uint8Array(4 + json.length);
    new DataView(out.buffer).setUint32(0, json.length);
    out.set(json, 4);
    port2.postMessage(out);
  };
  port2.onmessage = ({ data }: MessageEvent<Uint8Array>) => {
    const { id: re, op, args = [] } = JSON.parse(new TextDecoder().decode(data.subarray(4)));
    if (op === "subscribe") return say({ re, ok: true, n: 0, rows: [], projects: [] });
    if (op !== "run") return;
    const [command, what] = args as string[];
    if (command === "storage") return setTimeout(() => say({ re, ok: true, ...storage(args) }), DELAY[what ?? ""] ?? 40);
    const reply = replies[command!];
    say(reply ? { re, ok: true, ...reply } : { re, ok: false, message: "Not in this mockup" });
  };
  window.postMessage("daemon-port", "*", [port1]);
  say({ status: "running", pid: 1, version: "mockup", build: 0 });
}

/** Opens the app on it, at Storage unless another place is asked for. */
export async function openReal() {
  if (!location.hash || location.hash === "#") location.hash = "#settings/storage";
  daemon();
  await import("../src/main");
}
