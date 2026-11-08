// The composer (slice 1) in every state, frozen, plus one live copy.
import { type ReactNode, useEffect, useRef, useState } from "react";

import { type Attachment, AttachmentsContext } from "../src/components/composer/attachments";
import { ComposerCard, ComposerFooter, ComposerPill, ComposerTools, ContextRing, EditComposer, PillDivider, PlusButton } from "../src/components/composer/composer";
import { type Draft, EMPTY_DRAFT, isEmpty, sendMode } from "../src/components/composer/draft";
import { ComposerField, type ComposerFieldHandle } from "../src/components/composer/field";
import type { Commands } from "../src/components/composer/menus";
import { ComposerRail } from "../src/components/composer/rail";
import { SendButton } from "../src/components/composer/send-button";
import { Button } from "../src/components/button";
import { showToast } from "../src/components/toast";
import { ChevronDown } from "../src/icons";
import { duration, useSecond } from "../src/thread/words";
import { Row, Section, State } from "./parts";

const noop = () => {};
const draft = (...parts: Draft["parts"]): Draft => ({ parts, attachmentIds: [] });
const LONG = Array.from({ length: 24 }, (_, i) => `Line ${i + 1} of a long message that scrolls inside the field.`).join("\n");

export function ModelPill() {
  return (
    <ComposerPill className="gap-1">
      <span className="truncate text-foreground">Model name</span>
      <span>High</span>
      <ChevronDown className="size-icon-xs" />
    </ComposerPill>
  );
}

type CardProps = {
  initial?: Draft;
  placeholder?: string;
  running?: boolean;
  canStop?: boolean;
  canResume?: boolean;
  armed?: boolean;
  blocked?: string;
  ring?: boolean;
  /** Scrolled to its end, so the top line fades. */
  scrolled?: boolean;
  /** What the rail over the card holds. */
  rail?: ReactNode;
  /** A menu held open over the card, attachment tiles over the field, and what the chips show. */
  menu?: ReactNode;
  tiles?: ReactNode;
  attachments?: ReadonlyMap<string, Attachment>;
  /** The `/` menu's commands, which the text paints. */
  commands?: Commands;
};

/** A frozen composer card in one state. */
/** Rust's stand-in for opening what a chip names. */
export const openChip = (kind: string, id: string) => showToast(`Open ${kind} ${id}`);

export function Card({
  initial = EMPTY_DRAFT,
  placeholder = "Do anything",
  running = false,
  canStop = false,
  canResume,
  armed,
  blocked,
  ring,
  scrolled,
  rail,
  menu,
  tiles,
  attachments,
  commands,
}: CardProps) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrolled) box.current!.querySelector("[data-slot=composer-field]")!.scrollTop = 1e6;
  }, [scrolled]);
  return (
    <div ref={box} className="w-reading">
      {rail && <ComposerRail>{rail}</ComposerRail>}
      <ComposerCard>
        {menu}
        {tiles && <AttachmentsContext value={attachments ?? new Map()}>{tiles}</AttachmentsContext>}
        <ComposerField initial={initial} placeholder={placeholder} attachments={attachments} commands={commands} onOpen={openChip} />
        <ComposerFooter>
          <ComposerTools>
            <PlusButton />
          </ComposerTools>
          {ring && <ContextRing usedTokens={45_000} windowTokens={258_000} />}
          <ModelPill />
          <SendButton
            keys={false}
            empty={isEmpty(initial)}
            running={running}
            canStop={canStop}
            canResume={canResume}
            armed={armed}
            blocked={blocked}
            onSend={noop}
            onStop={noop}
            onResume={noop}
          />
        </ComposerFooter>
      </ComposerCard>
    </div>
  );
}

/** The live copy: type, ⏎ sends (⌥⏎ the other way), ↑ walks back through what was sent, Esc twice stops. */
function Live() {
  const field = useRef<ComposerFieldHandle>(null);
  const [empty, setEmpty] = useState(true);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [linkDown, setLinkDown] = useState(false);
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
        <Button size="sm" variant={running ? "default" : "outline"} onClick={() => setStartedAt(running ? null : Date.now())}>
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
            onStop={() => setStartedAt(null)}
          />
        </ComposerFooter>
      </ComposerCard>
    </div>
  );
}

export function ComposerGallery() {
  const mention = { kind: "mention", id: "m1", type: "file", label: "app/ui/src/components/composer/field.tsx" } as const;
  return (
    <Section title="Composer">
      <Row name="Card">
        <State label="Empty">
          <Card />
        </State>
        <State label="Typing, with a mention chip">
          <Card initial={draft("Look at ", mention, " and fix the Enter key")} />
        </State>
        <State label="Multi-line">
          <Card initial={draft("First line\nSecond line\nThird line")} />
        </State>
        <State label="Scrolled: the top line fades">
          <Card initial={draft(LONG)} scrolled />
        </State>
        <State label="Turn running, empty: Stop">
          <Card placeholder="Working for 2m 5s" running canStop />
        </State>
        <State label="Turn running, typed: Send queues (tip Queue)">
          <Card initial={draft("And add a test")} running canStop />
        </State>
        <State label="Esc armed (tip Press Esc again to stop)">
          <Card initial={draft("And add a test")} running canStop armed />
        </State>
        <State label="Stopped: Resume">
          <Card canResume />
        </State>
        <State label="Reconnecting: Send disabled">
          <Card initial={draft("Kept while it reconnects")} placeholder="Reconnecting…" blocked="Reconnecting…" />
        </State>
        <State label="Context ring">
          <Card ring />
        </State>
      </Row>
      <Row name="Footer controls">
        {(["hover", "focus", "active"] as const).map((frozen) => (
          <State key={frozen} label={frozen} frozen={frozen}>
            <PlusButton />
            <PillDivider />
            <ModelPill />
            <SendButton keys={false} empty={false} running={false} canStop={false} onSend={noop} onStop={noop} />
          </State>
        ))}
        <State label="⌘ held in a project session: ↗ starts a new session">
          <SendButton keys={false} asNew empty={false} running={false} canStop={false} onSend={noop} onSendNew={noop} onStop={noop} />
        </State>
      </Row>
      <Row name="Edit and resend">
        <State label="Editing a sent message">
          <div className="w-reading">
            <EditComposer initial={draft("Fix the Enter key in the composer")} onCancel={noop} onSend={noop} />
          </div>
        </State>
      </Row>
      <Row name="Live">
        <Live />
      </Row>
    </Section>
  );
}
