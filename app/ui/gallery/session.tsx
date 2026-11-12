// The composer in a session (1p), wired as in the app, on a stand-in for Rust that keeps the queue and runs turns.
import { useRef, useState, useSyncExternalStore } from "react";

import { CheckboxRow } from "../src/components/checkbox-row";
import type { Row as SessionRow } from "../src/daemon";
import { type ComposerRow, type Runner, SentBubbles, SessionComposer } from "../src/session/composer";
import { LevelPicker } from "../src/session/level";
import type { Session } from "../src/thread/item";
import type { Source } from "../src/thread/thread";
import { Row, Section, State } from "./parts";

const TURN_MS = 6000;
const REPLY_MS = 400;
const later = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Rust's stand-in: a row with its queue, a thread of turns, and the commands the composer runs. */
function useStandIn() {
  const base = { id: "g1", title: "", state: "idle", reason: null, mark: null, resets: null, sent: 0, finished: 0, project: null, backend: "fake", updated: 0, items: 0, error: null, levels: ["ask", "auto", "full"], level: "auto" } as SessionRow;
  const [row, setRow] = useState<ComposerRow>({ ...base, touched: 0, running: false, steer: true, queue: { paused: false, items: [] } });
  const [lines, setLines] = useState<string[]>([]);
  const [refuse, setRefuse] = useState(false);
  const state = useRef({ row, refuse, timer: 0 as unknown as ReturnType<typeof setTimeout> });
  state.current.refuse = refuse;
  const listeners = useRef(new Set<() => void>());
  const thread = useRef<Session>({ id: "g1", title: "", turns: [], items: [] });
  const source = useRef<Source>({
    subscribe: (listener) => (listeners.current.add(listener), () => listeners.current.delete(listener)),
    get: () => thread.current,
  }).current;

  const update = (change: (now: ComposerRow) => Partial<ComposerRow>) => {
    const now = state.current.row;
    const next = { ...now, ...change(now), touched: Math.max(Date.now(), (now.touched ?? 0) + 1) };
    state.current.row = next;
    setRow(next);
    return next.touched;
  };
  const say = (line: string) => {
    setLines((all) => [...all.slice(-5), line]);
    thread.current = { ...thread.current };
    listeners.current.forEach((listener) => listener());
  };
  const queueOf = (now: ComposerRow) => now.queue ?? { paused: false, items: [] };
  const start = (cid: string, text: string) => {
    thread.current = { ...thread.current, turns: [...thread.current.turns, { id: cid, status: "running", startedAt: Date.now(), endedAt: null }] };
    say(`Turn: ${text}`);
    update(() => ({ running: true }));
    clearTimeout(state.current.timer);
    state.current.timer = setTimeout(end, TURN_MS);
  };
  // A turn's end sends the first queued message, unless Stop paused the queue.
  function end() {
    update(() => ({ running: false }));
    const queue = queueOf(state.current.row);
    const first = queue.items[0];
    if (queue.paused || !first) return;
    update(() => ({ queue: { ...queue, items: queue.items.slice(1) } }));
    start(first.id, first.text);
  }

  const run: Runner = async (args) => {
    await later(REPLY_MS);
    if (state.current.refuse) return { ok: false, result: "refused", error: "The stand-in refused it" };
    const now = state.current.row;
    const queue = queueOf(now);
    const [cmd, , a, b] = args;
    const flag = (name: string) => args[args.indexOf(name) + 1];
    if (cmd === "stop") {
      clearTimeout(state.current.timer);
      say("You stopped");
      update(() => ({ running: false, queue: { ...queue, paused: queue.items.length > 0 } }));
      return { ok: true };
    }
    if (cmd === "send" && args.includes("--steer")) {
      if (!now.running) return { ok: false, result: "refused", error: "not_running" };
      say(`Steered: ${a}`);
      return { ok: true, result: "delivered" };
    }
    if (cmd === "send") {
      start(flag("--cid")!, a!);
      return { ok: true, result: "delivered" };
    }
    const items = queue.items.filter((each) => each.id !== b);
    // What the queue holds after a command; an edit's kept copy goes with the add or remove of its id.
    const target = a === "add" ? flag("--qid") : b;
    const editing = queue.editing?.id === target && (a === "add" || a === "remove") ? null : queue.editing;
    const at = (paused: boolean, list: typeof items, kept = editing) => ({ ok: true, at: update(() => ({ queue: { paused: paused && list.length > 0, items: list, editing: kept } })) });
    switch (a) {
      case "add": {
        const slot = args.includes("--at") ? Number(flag("--at")) : queue.items.length;
        return at(queue.paused, queue.items.toSpliced(slot, 0, { id: flag("--qid")!, text: b! }));
      }
      case "remove":
        return at(queue.paused, items);
      case "edit": {
        const item = queue.items.find((each) => each.id === b)!;
        return at(queue.paused, items, { id: b!, text: item.text, slot: queue.items.indexOf(item) });
      }
      case "restore": {
        const kept = queue.editing;
        return at(queue.paused, kept ? queue.items.toSpliced(kept.slot, 0, { id: kept.id, text: kept.text }) : queue.items, null);
      }
      case "move":
        return at(queue.paused, items.toSpliced(Number(args[4]), 0, queue.items.find((each) => each.id === b)!));
      case "steer": {
        if (!now.running) return { ok: false, result: "refused", error: "not_running" };
        say(`Steered: ${queue.items.find((each) => each.id === b)?.text}`);
        return at(queue.paused, items);
      }
      case "resume": {
        const reply = at(false, queue.items);
        if (!state.current.row.running) end();
        return reply;
      }
    }
    return { ok: false, error: `unknown command ${args.join(" ")}` };
  };
  return { row, lines, source, run, refuse, setRefuse, setSteer: (steer: boolean) => update(() => ({ steer })) };
}

/** Live: ⏎ starts a turn (six seconds), then queues; ⌘⏎ steers; Esc Esc stops and pauses the queue; Resume sends it on. */
function Live() {
  const standIn = useStandIn();
  const [offline, setOffline] = useState(false);
  useSyncExternalStore(standIn.source.subscribe, standIn.source.get);
  return (
    <div className="flex w-reading flex-col gap-3">
      <div className="flex flex-col gap-1 rounded-control bg-muted p-3 text-sm text-muted-foreground">
        {standIn.lines.length === 0 ? "The thread's turns show here." : standIn.lines.map((line, at) => <span key={at}>{line}</span>)}
        <span>{standIn.row.running ? "A turn runs" : "Idle"}</span>
      </div>
      <SentBubbles id="g1" source={standIn.source} run={standIn.run} />
      <SessionComposer id="g1" row={standIn.row} offline={offline} run={standIn.run} source={standIn.source} />
      <div className="flex flex-wrap gap-4">
        <CheckboxRow label="The agent can steer" checked={standIn.row.steer === true} onCheckedChange={standIn.setSteer} />
        <CheckboxRow label="Refuse every command" checked={standIn.refuse} onCheckedChange={standIn.setRefuse} />
        <CheckboxRow label="Offline" checked={offline} onCheckedChange={setOffline} />
      </div>
    </div>
  );
}

export function SessionGallery() {
  return (
    <Section title="Composer in a session">
      <Row name="Live, on a stand-in for Rust">
        <Live />
      </Row>
      <Row name="Permission pill: each agent's own levels">
        <State label="Three levels, a trusted project: Auto">
          <LevelPicker levels={["ask", "auto", "full"]} level="auto" held={false} onChange={() => {}} />
        </State>
        <State label="No auto mode: Ask">
          <LevelPicker levels={["ask", "full"]} level="ask" held={false} onChange={() => {}} />
        </State>
        <State label="An untrusted project: Ask, locked">
          <LevelPicker levels={["ask", "auto", "full"]} level="ask" held onChange={() => {}} />
        </State>
        <State label="No levels: no pill">
          <LevelPicker levels={[]} level={null} held={false} onChange={() => {}} />
        </State>
      </Row>
    </Section>
  );
}
