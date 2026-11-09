// The composer (slice 1): one live copy to play with, and the edit-and-resend composer.
import { useRef, useState } from "react";

import { ComposerCard, ComposerFooter, ComposerPill, ComposerTools, ContextRing, EditComposer, PillDivider, PlusButton } from "../src/components/composer/composer";
import { type Draft, isEmpty, sendMode } from "../src/components/composer/draft";
import { ComposerField, type ComposerFieldHandle } from "../src/components/composer/field";
import { SendButton } from "../src/components/composer/send-button";
import { Button } from "../src/components/button";
import { showToast } from "../src/components/toast";
import { ChevronDown } from "../src/icons";
import { duration, useSecond } from "../src/thread/words";
import { Section } from "./parts";

const draft = (...parts: Draft["parts"]): Draft => ({ parts, attachmentIds: [] });

export function ModelPill() {
  return (
    <ComposerPill className="gap-1">
      <span className="truncate text-foreground">Model name</span>
      <span>High</span>
      <ChevronDown className="size-icon-xs" />
    </ComposerPill>
  );
}

/** Rust's stand-in for opening what a chip names. */
export const openChip = (kind: string, id: string) => showToast(`Open ${kind} ${id}`);

/** The live copy: type, ⏎ sends (⌥⏎ the other way), ↑ walks back through what was sent, Esc twice stops. */
function Live() {
  const field = useRef<ComposerFieldHandle>(null);
  const [empty, setEmpty] = useState(true);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [linkDown, setLinkDown] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [sent, setSent] = useState<{ mode: string; parts: Draft["parts"] }[]>([]);
  const running = startedAt !== null;
  const now = useSecond(running);
  const send = (other = false) => {
    const parts = field.current!.parts();
    if (linkDown || isEmpty(draft(...parts))) return;
    setSent((list) => [...list, { mode: sendMode(running, "queue", other, true), parts }]);
    field.current!.set([]);
  };
  const placeholder = linkDown ? "Reconnecting…" : running ? `Working for ${duration(now - startedAt)}` : "Do anything";
  return (
    <div className="flex w-full max-w-reading flex-col gap-3">
      <div className="flex gap-2">
        <Button
          size="sm"
          variant={running ? "default" : "outline"}
          onClick={() => {
            setStopped(false);
            setStartedAt(running ? null : Date.now());
          }}
        >
          Turn running
        </Button>
        <Button size="sm" variant={linkDown ? "default" : "outline"} onClick={() => setLinkDown(!linkDown)}>
          Reconnecting
        </Button>
      </div>
      <ol className="flex flex-col gap-1 text-sm text-muted-foreground">
        {sent.map((each, at) => (
          <li key={at} className="truncate">
            {each.mode} · {each.parts.map((part) => (typeof part === "string" ? part : `@${part.kind}`)).join("")}
          </li>
        ))}
      </ol>
      <ComposerCard>
        <ComposerField
          ref={field}
          placeholder={placeholder}
          prompts={sent.map((each) => draft(...each.parts))}
          onChange={(parts) => setEmpty(isEmpty(draft(...parts)))}
          onSubmit={send}
        />
        <ComposerFooter>
          <ComposerTools>
            <PlusButton />
            <PillDivider />
            <ComposerPill>Pill</ComposerPill>
          </ComposerTools>
          <ContextRing usedTokens={45_000} windowTokens={258_000} />
          <ModelPill />
          <SendButton
            empty={empty}
            running={running}
            canStop={running}
            blocked={linkDown ? "Reconnecting…" : undefined}
            onSend={() => send()}
            canResume={stopped}
            onStop={() => {
              setStartedAt(null);
              setStopped(true);
            }}
            onResume={() => {
              setStopped(false);
              setStartedAt(Date.now());
            }}
          />
        </ComposerFooter>
      </ComposerCard>
    </div>
  );
}

/** Opened by a press, as a sent message's Edit opens it: it takes focus as it mounts, which would scroll the page on load. */
function EditLive() {
  const [editing, setEditing] = useState(false);
  if (!editing)
    return (
      <Button size="sm" variant="outline" className="self-start" onClick={() => setEditing(true)}>
        Edit a sent message
      </Button>
    );
  return (
    <div className="w-full max-w-reading">
      <EditComposer initial={draft("Fix the Enter key in the composer")} onCancel={() => setEditing(false)} onSend={() => setEditing(false)} />
    </div>
  );
}

export function ComposerGallery() {
  return (
    <>
      <Section title="Composer">
        <Live />
      </Section>
      <Section title="Edit and resend">
        <EditLive />
      </Section>
    </>
  );
}
