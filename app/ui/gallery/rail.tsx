// The composer rail (slice 2) in every state, frozen, plus one live copy.
import { useRef, useState } from "react";

import { Button } from "../src/components/button";
import { ComposerCard, ComposerFooter, ComposerTools, PlusButton } from "../src/components/composer/composer";
import { type Draft, isEmpty } from "../src/components/composer/draft";
import { ComposerField, type ComposerFieldHandle } from "../src/components/composer/field";
import { QueueCard, type QueuedMessage } from "../src/components/composer/queue";
import { ComposerRail, HeldRow, Notices, PausedSendDialog, WaitingRow } from "../src/components/composer/rail";
import { SendButton } from "../src/components/composer/send-button";
import { Card, ModelPill } from "./composer";
import { Held, Row, Section, State } from "./parts";

const noop = () => {};
const draft = (...parts: Draft["parts"]): Draft => ({ parts, attachmentIds: [] });
const mention = { kind: "mention", id: "m1", type: "file", label: "app/ui/src/components/composer/field.tsx" } as const;
const item = (id: string, state: QueuedMessage["state"], ...parts: Draft["parts"]): QueuedMessage => ({ id, state, draft: draft(...parts) });

const ONE = [item("q1", "queued", "Also update the README with the new keys")];
const MANY = [
  item("q1", "queued", "Also update the README with the new keys"),
  item("q2", "queued", "Then run the checks in ", mention, " and fix what fails"),
  item("q3", "queued", "Does it look like this?", { kind: "image", attachmentId: "a1" }),
  { id: "q4", state: "queued", draft: { parts: [], attachmentIds: ["f1", "f2"] } } satisfies QueuedMessage,
  item("q5", "queued", "A long follow-up that goes on well past the width of the card, so its end is cut off with an ellipsis and shown whole on hover"),
];

/** The queue with no-op actions, except moves: Rust's stand-in confirms each one a moment later. */
function Queue({ items: start = ONE, ...props }: Partial<Parameters<typeof QueueCard>[0]>) {
  const [items, setItems] = useState(start);
  const confirm = (id: string, to: number) =>
    new Promise<void>((done) =>
      setTimeout(() => {
        setItems((list) => {
          const rest = list.filter((each) => each.id !== id);
          rest.splice(to, 0, list.find((each) => each.id === id)!);
          return rest;
        });
        done();
      }, 400),
    );
  return <QueueCard items={items} canEdit onResume={noop} onSteer={noop} onRemove={noop} onEdit={noop} onMove={confirm} {...props} />;
}

type Notice = { id: number; level: "info" | "warning" | "error"; text: string };

const retry = (
  <Button variant="link-blue" size="xs" className="-my-0.5">
    Retry
  </Button>
);
const LOAD_ERROR = { level: "warning", text: "Couldn’t load messages", action: retry } as const;
const LONG = {
  level: "error",
  text: "The agent stopped: its process exited (code 1). The last thing it printed was: error: could not compile `brigadier-core` (lib) due to 3 previous errors; warning: build failed, waiting for other jobs to finish. Check the terminal for the full log.",
} as const;
const LONG_RETRY = {
  level: "warning",
  text: "Couldn’t load messages: the session's history file is locked by another process, so its newest turns can't be read until that process lets go of it.",
  action: retry,
} as const;

/** The notices, live: arrows page, ✕ dismisses, Reset brings them back. */
function SampleNotices({ samples = NOTICE_SAMPLES }: { samples?: readonly Omit<Parameters<typeof Notices>[0]["notices"][number], "id">[] }) {
  const all = samples.map((notice, id) => ({ ...notice, id }));
  const [notices, setNotices] = useState(all);
  return (
    <div className="flex flex-col items-start gap-2">
      <Card rail={<Notices notices={notices} onDismiss={(id) => setNotices((list) => list.filter((each) => each.id !== id))} />} />
      <Button size="xs" variant="ghost" onClick={() => setNotices(all)}>
        Reset
      </Button>
    </div>
  );
}
const NOTICE_SAMPLES: Omit<Notice, "id">[] = [
  { level: "warning", text: "Git isn't set up in this folder, so changes can't be reviewed." },
  { level: "info", text: "The model changed to a smaller one for this turn." },
  { level: "error", text: "The agent stopped: its process exited (code 1)." },
];

/**
 * The live copy. While "Turn running" is on, ⏎ queues (shown pending for a moment, then queued); ↑ in the
 * empty field or ⋯ › Edit message pulls one back; drag the grip or press ↑/↓ on it to reorder. Stop pauses
 * the queue, and sending then asks first.
 */
function Live() {
  const field = useRef<ComposerFieldHandle>(null);
  const next = useRef(1);
  const [empty, setEmpty] = useState(true);
  const [running, setRunning] = useState(true);
  const [paused, setPaused] = useState(false);
  const [queue, setQueue] = useState<QueuedMessage[]>(MANY.slice(0, 2));
  const [notices, setNotices] = useState<Notice[]>([{ id: 0, ...NOTICE_SAMPLES[0]! }]);
  const [held, setHeld] = useState<Draft | null>(draft("Rename the field to Message"));
  const [ask, setAsk] = useState<Draft | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const say = (line: string) => setLog((lines) => [...lines.slice(-4), line]);
  const words = (d: Draft) => d.parts.map((part) => (typeof part === "string" ? part : `@${part.kind}`)).join("");

  const fieldEmpty = () => isEmpty(draft(...field.current!.parts()));
  const take = () => {
    const d = draft(...field.current!.parts());
    field.current!.set([]);
    return d;
  };
  const enqueue = (d: Draft) => {
    const id = `live${next.current++}`;
    setQueue((list) => [...list, { id, state: "local", draft: d }]);
    setTimeout(() => setQueue((list) => list.map((each) => (each.id === id ? { ...each, state: "queued" } : each))), 800);
  };
  const send = () => {
    const d = draft(...field.current!.parts());
    if (isEmpty(d)) return;
    if (paused && queue.length > 0) return setAsk(d);
    if (!running) return say(`sent · ${words(take())}`);
    enqueue(take());
  };
  const pull = (id: string) => {
    const found = queue.find((each) => each.id === id);
    if (!found || !fieldEmpty()) return false;
    setQueue((list) => list.filter((each) => each.id !== id));
    field.current!.set(found.draft.parts);
    return true;
  };

  return (
    <div className="flex w-full max-w-reading flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={running ? "default" : "outline"} onClick={() => setRunning(!running)}>
          Turn running
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setNotices((list) => [...list, { id: next.current++, ...NOTICE_SAMPLES[next.current % NOTICE_SAMPLES.length]! }])}
        >
          Add a notice
        </Button>
        <Button size="sm" variant="outline" onClick={() => setHeld(draft("Rename the field to Message"))}>
          Hold a message
        </Button>
      </div>
      <ol className="flex flex-col gap-1 text-sm text-muted-foreground">
        {log.map((line, at) => (
          <li key={at} className="truncate">
            {line}
          </li>
        ))}
      </ol>
      <div>
        <ComposerRail>
          <Notices notices={notices} onDismiss={(id) => setNotices((list) => list.filter((each) => each.id !== id))} />
          <QueueCard
            items={queue}
            paused={paused}
            steer
            canEdit={empty}
            onResume={() => setPaused(false)}
            onSteer={(id) => {
              say(`steered · ${words(queue.find((each) => each.id === id)!.draft)}`);
              setQueue((list) => list.filter((each) => each.id !== id));
            }}
            onRemove={(id) => setQueue((list) => list.filter((each) => each.id !== id))}
            onEdit={pull}
            onMove={(id, to) =>
              setQueue((list) => {
                const rest = list.filter((each) => each.id !== id);
                rest.splice(to, 0, list.find((each) => each.id === id)!);
                return rest;
              })
            }
          />
          {held && (
            <HeldRow
              reason="the session ended before it went"
              onRestore={() => {
                if (!fieldEmpty()) return say("clear the field to restore it");
                field.current!.set(held.parts);
                setHeld(null);
              }}
              onDiscard={() => setHeld(null)}
            />
          )}
        </ComposerRail>
        <ComposerCard>
          <ComposerField
            ref={field}
            placeholder={running ? "Working for 2m 5s" : "Do anything"}
            onChange={(parts) => setEmpty(isEmpty(draft(...parts)))}
            onSubmit={send}
            onPullQueued={() => {
              const last = queue.findLast((each) => each.state !== "local");
              return last ? pull(last.id) : false;
            }}
          />
          <ComposerFooter>
            <ComposerTools>
              <PlusButton />
            </ComposerTools>
            <ModelPill />
            <SendButton
              empty={empty}
              running={running}
              canStop={running}
              onSend={send}
              onStop={() => {
                setRunning(false);
                setPaused(queue.length > 0);
              }}
            />
          </ComposerFooter>
        </ComposerCard>
      </div>
      <PausedSendDialog
        waiting={ask && queue.length}
        onClose={() => setAsk(null)}
        onKeepPaused={() => {
          setAsk(null);
          enqueue(take());
        }}
        onSendNow={() => {
          setAsk(null);
          say(`sent now · ${words(take())}`);
        }}
      />
    </div>
  );
}

export function RailGallery() {
  return (
    <Section title="Composer rail">
      <Row name="Notices">
        <State label="Three: one at a time, newest first; ‹ › or ←/→ page, ✕ dismisses the one shown">
          <SampleNotices />
        </State>
        <State label="Three, one with Retry">
          <SampleNotices samples={[NOTICE_SAMPLES[0]!, NOTICE_SAMPLES[2]!, LOAD_ERROR]} />
        </State>
        <State label="One, with Retry (no pager)">
          <SampleNotices samples={[LOAD_ERROR]} />
        </State>
        <State label="Long: one line until the chevron opens it">
          <SampleNotices samples={[NOTICE_SAMPLES[1]!, LONG]} />
        </State>
        <State label="Long, with Retry">
          <SampleNotices samples={[LONG_RETRY]} />
        </State>
        <State label="One (no pager)">
          <SampleNotices samples={[NOTICE_SAMPLES[1]!]} />
        </State>
      </Row>
      <Row name="Queue">
        <State label="One">
          <Card running canStop rail={<Queue />} />
        </State>
        <State label="Many: mention, image, files only, long; Steer offered">
          <Card running canStop rail={<Queue items={MANY} steer />} />
        </State>
        <State label="Hover: the grip takes the glyph's place" frozen="hover">
          <Card running canStop rail={<Queue items={MANY.slice(0, 2)} steer />} />
        </State>
        <State label="Deciding">
          <Card running canStop rail={<Queue items={[item("q1", "deciding", "Also make the field taller"), ...MANY.slice(1, 2)]} />} />
        </State>
        <State label="Paused after an interrupt">
          <Card canResume rail={<Queue items={MANY.slice(0, 2)} paused />} />
        </State>
        <State label="Resuming">
          <Card rail={<Queue items={MANY.slice(0, 2)} paused resuming />} />
        </State>
        <State label="An action failed">
          <Card running canStop rail={<Queue items={MANY.slice(0, 2)} error="Couldn't delete the message. Try again." />} />
        </State>
        <State label="Just sent: actions wait, disabled">
          <Card running canStop rail={<Queue items={[...ONE, item("q9", "local", "Just sent, not confirmed yet")]} steer />} />
        </State>
      </Row>
      <Row name="Held message, waiting decisions">
        <State label="Held">
          <Card rail={<HeldRow reason="the session ended before it went" onRestore={noop} onDiscard={noop} />} />
        </State>
        <State label="One decision put aside">
          <Card rail={<WaitingRow count={1} onShow={noop} />} />
        </State>
        <State label="Everything at once">
          <Card
            running
            canStop
            rail={
              <>
                <Notices notices={[{ id: 0, ...NOTICE_SAMPLES[0]! }]} onDismiss={noop} />
                <Queue items={MANY.slice(0, 2)} steer />
                <HeldRow reason="the session ended before it went" onRestore={noop} onDiscard={noop} />
                <WaitingRow count={3} onShow={noop} />
              </>
            }
          />
        </State>
      </Row>
      <Row name="Sending while the queue is paused">
        <State label="Asks first">
          <Held className="h-56 w-reading">
            {(box) => <PausedSendDialog held={box} waiting={2} onSendNow={noop} onKeepPaused={noop} onClose={noop} />}
          </Held>
        </State>
      </Row>
      <Row name="Live">
        <Live />
      </Row>
    </Section>
  );
}
