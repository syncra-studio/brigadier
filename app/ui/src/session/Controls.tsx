import { useEffect, useSyncExternalStore, type ReactNode } from "react";

import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { Switch } from "../components/switch";
import type { Item } from "../thread/item";
import { preview, type Fake, type FakeCommand, type Knobs } from "./fake";
import { useNow, type State } from "./shown";
import { newId, type Session } from "./store";

// Which states have been on screen, for the checklist.
const seen = new Set<string>();
const seenListeners = new Set<() => void>();
let seenVersion = 0;
const subscribeSeen = (listener: () => void) => {
  seenListeners.add(listener);
  return () => seenListeners.delete(listener);
};
const useSeenVersion = (): number => useSyncExternalStore(subscribeSeen, () => seenVersion);
const wasSeen = (state: string): boolean => seen.has(state);
export function useSeen(state: string | null): void {
  useEffect(() => {
    if (!state || seen.has(state)) return;
    seen.add(state);
    seenVersion += 1;
    for (const listener of seenListeners) listener();
  }, [state]);
}

const STATES: State[] = ["loading", "empty", "pending", "error", "disconnected", "reconnecting", "interrupted", "stalled", "unknown"];

/** The demo's side panel: what the fake backend does next, and which states have shown. */
export function Controls({
  fake,
  session,
  reopen,
  wait,
  setWait,
}: {
  fake: Fake;
  session: Session<Item, FakeCommand>;
  reopen: () => void;
  wait: boolean;
  setWait: (wait: boolean) => void;
}) {
  // The fake turns its one-shot knobs off itself; a quick tick keeps the panel true to them.
  useNow(true, 250);
  useSeenVersion();
  const { knobs } = fake;
  const arm = (knob: keyof Omit<Knobs, "delayMs" | "reorder">) => () => {
    knobs[knob] = !knobs[knob];
  };
  return (
    <aside className="flex w-80 shrink-0 flex-col gap-5 overflow-y-auto border-l border-divider bg-chrome px-4 pt-titlebar pb-4 text-sm">
      <Group title="Shown so far">
        <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-label">
          {STATES.map((state) => (
            <li key={state} className={wasSeen(state) ? "text-success" : "text-muted-foreground"}>
              {wasSeen(state) ? "✓" : "·"} {state}
            </li>
          ))}
        </ul>
      </Group>
      <Group title="This window">
        <label className="flex items-center gap-2 text-label">
          <Switch checked={wait} onCheckedChange={setWait} />
          Wait for the backend · not optimistic
        </label>
      </Group>
      <Group title="Backend">
        <label className="flex flex-col gap-1">
          <span className="text-label">Answer delay · {knobs.delayMs} ms</span>
          <input type="range" min={0} max={5000} step={100} defaultValue={knobs.delayMs} onChange={(event) => (knobs.delayMs = Number(event.target.value))} />
        </label>
        <label className="flex items-center gap-2 text-label">
          <Checkbox defaultChecked={knobs.reorder} onCheckedChange={(checked) => (knobs.reorder = checked)} />
          Deliver frames out of order
        </label>
      </Group>
      <Group title="The next send">
        <Toggle on={knobs.failNext} onClick={arm("failNext")}>Refused by the backend</Toggle>
        <Toggle on={knobs.loseNextSend} onClick={arm("loseNextSend")}>Lost on the way, connection drops</Toggle>
        <Toggle on={knobs.dropAfterNextSend} onClick={arm("dropAfterNextSend")}>Arrives, then the connection drops</Toggle>
        <Action
          onClick={() => {
            const id = newId();
            session.send(id, { text: "Sent twice under one id" }, preview(id, "Sent twice under one id"));
            session.send(id, { text: "Sent twice under one id" }, preview(id, "Sent twice under one id"));
          }}
        >
          Send twice under one id
        </Action>
      </Group>
      <Group title="Connection">
        <Toggle on={knobs.loseNextFrame} onClick={arm("loseNextFrame")}>Lose the next frame</Toggle>
        <Action onClick={fake.dropLink}>Drop the connection</Action>
        <Action onClick={fake.killDaemon}>Stop the background service</Action>
        <Action onClick={fake.startDaemon}>Start the background service</Action>
        <Action onClick={reopen}>Reopen the window</Action>
      </Group>
      <Group title="What the backend reports">
        <Action onClick={fake.stall}>Run stalls</Action>
        <Action onClick={fake.interrupt}>Run is interrupted</Action>
        <Action onClick={fake.fail}>Run fails</Action>
        <Action onClick={fake.clear}>Thread is cleared</Action>
      </Group>
      <a href="#" className="mt-auto text-label text-muted-foreground hover:text-foreground">
        Back to Brigadier
      </a>
    </aside>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Action({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button size="sm" variant="outline" onClick={onClick}>
      {children}
    </Button>
  );
}

/** A one-shot: armed until the fake uses it. */
function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button size="sm" variant={on ? "secondary" : "outline"} aria-pressed={on} onClick={onClick}>
      {on ? "Armed · " : ""}
      {children}
    </Button>
  );
}
