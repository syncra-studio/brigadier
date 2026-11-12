// The composer rail (slice 2): one live copy of the queue, notices and held message.
import { useRef, useState } from "react";

import { Button } from "../src/components/button";
import { ComposerCard, ComposerFooter, ComposerTools, PlusButton } from "../src/components/composer/composer";
import { type Draft, isEmpty } from "../src/components/composer/draft";
import { ComposerField, type ComposerFieldHandle } from "../src/components/composer/field";
import { QueueCard, type QueuedMessage } from "../src/components/composer/queue";
import { ComposerRail, Notices, PausedSendDialog } from "../src/components/composer/rail";
import { SendButton } from "../src/components/composer/send-button";
import { LevelPill, ModelPill } from "./composer";
import { Section } from "./parts";

const draft = (...parts: Draft["parts"]): Draft => ({ parts, attachmentIds: [] });
const mention = { kind: "mention", id: "m1", type: "file", label: "app/ui/src/components/composer/field.tsx" } as const;
const item = (id: string, state: QueuedMessage["state"], ...parts: Draft["parts"]): QueuedMessage => ({ id, state, draft: draft(...parts) });

const MANY = [
  item("q1", "queued", "Also update the README with the new keys"),
  item("q2", "queued", "Then run the checks in ", mention, " and fix what fails"),
  item("q3", "queued", "Does it look like this?", { kind: "image", attachmentId: "a1" }),
  { id: "q4", state: "queued", draft: { parts: [], attachmentIds: ["f1", "f2"] } } satisfies QueuedMessage,
  item("q5", "queued", "A long follow-up that goes on well past the width of the card, so its end is cut off with an ellipsis and shown whole on hover"),
];

type Notice = Parameters<typeof Notices>[0]["notices"][number];

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
const NOTICE_SAMPLES: Omit<Notice, "id">[] = [
  { level: "warning", text: "Git isn't set up in this folder, so changes can't be reviewed." },
  { level: "info", text: "The model changed to a smaller one for this turn." },
  { level: "error", text: "The agent stopped: its process exited (code 1)." },
  LOAD_ERROR,
  LONG,
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
            notSent={
              held && {
                draft: held,
                reason: "the session ended before it went",
                onRestore: () => {
                  if (!fieldEmpty()) return say("clear the field to restore it");
                  field.current!.set(held.parts);
                  setHeld(null);
                },
                onDiscard: () => setHeld(null),
              }
            }
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
              <LevelPill />
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
    <Section title="Rail: message queue, notices, held message">
      <Live />
    </Section>
  );
}
