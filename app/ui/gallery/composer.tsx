// The composer (slice 1) in every state, frozen, plus one live copy. While reviewing, each state shows
// "Current | Old app" (D22); the old column is deleted before landing.
import { Button as BaseButton } from "@base-ui/react/button";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { ComposerCard, ComposerFooter, ComposerPill, ComposerTools, ContextRing, EditComposer, PillDivider, PlusButton } from "../src/components/composer/composer";
import { type Draft, EMPTY_DRAFT, isEmpty, sendMode } from "../src/components/composer/draft";
import { ComposerField, type ComposerFieldHandle } from "../src/components/composer/field";
import { SendButton } from "../src/components/composer/send-button";
import { Button } from "../src/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../src/components/tooltip";
import { ChevronDown, Plus } from "../src/icons";
import { duration, useSecond } from "../src/thread/words";
import { Row, Section, State } from "./parts";

const noop = () => {};
const draft = (...parts: Draft["parts"]): Draft => ({ parts, attachmentIds: [] });
const LONG = Array.from({ length: 24 }, (_, i) => `Line ${i + 1} of a long message that scrolls inside the field.`).join("\n");

/** Old app: the + button was a capsule on hover, and the footer pills didn't shrink when pressed. */
function OldPlus() {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={0}
        render={
          <BaseButton aria-label="Add files and more" className="inline-flex size-control-sm items-center justify-center rounded-capsule transition-all hover:bg-fill svg:size-icon-md motion-safe:active:scale-press">
            <Plus />
          </BaseButton>
        }
      />
      <TooltipContent side="bottom">Add files and more</TooltipContent>
    </Tooltip>
  );
}
function OldPill({ children }: { children: ReactNode }) {
  return (
    <BaseButton className="inline-flex h-control-sm min-w-0 shrink-0 items-center gap-1.5 rounded-capsule px-2 text-sm text-muted-foreground transition-colors hover:bg-fill svg:size-icon-md">
      {children}
    </BaseButton>
  );
}

function ModelPill({ old }: { old: boolean }) {
  const words = (
    <>
      <span className="truncate text-foreground">Model name</span>
      <span>High</span>
      <ChevronDown className="size-icon-xs" />
    </>
  );
  return old ? <OldPill>{words}</OldPill> : <ComposerPill className="gap-1">{words}</ComposerPill>;
}

type CardProps = {
  old: boolean;
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
};

/** A frozen composer card in one state. */
function Card({ old, initial = EMPTY_DRAFT, placeholder = "Do anything", running = false, canStop = false, canResume, armed, blocked, ring, scrolled }: CardProps) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrolled) box.current!.querySelector("[data-slot=composer-field]")!.scrollTop = 1e6;
  }, [scrolled]);
  return (
    <div ref={box} className="w-full max-w-reading">
      <ComposerCard>
        <ComposerField initial={initial} placeholder={placeholder} />
        <ComposerFooter>
          <ComposerTools>{old ? <OldPlus /> : <PlusButton />}</ComposerTools>
          {ring && <ContextRing usedTokens={45_000} windowTokens={258_000} />}
          <ModelPill old={old} />
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

/** One state side by side: the kit now, and the old app's look. */
function Pair({ label, frozen, children }: { label: string; frozen?: string; children: (old: boolean) => ReactNode }) {
  return (
    <div className="grid w-full grid-cols-2 gap-8">
      <State label={`${label} · Current`} frozen={frozen}>
        {children(false)}
      </State>
      <State label={`${label} · Old app`} frozen={frozen}>
        {children(true)}
      </State>
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
  const placeholder = linkDown ? "Waiting for the link to come back" : running ? `Working for ${duration(now - startedAt)}` : "Do anything";
  return (
    <div className="flex w-full max-w-reading flex-col gap-3">
      <div className="flex gap-2">
        <Button size="sm" variant={running ? "default" : "outline"} onClick={() => setStartedAt(running ? null : Date.now())}>
          Turn running
        </Button>
        <Button size="sm" variant={linkDown ? "default" : "outline"} onClick={() => setLinkDown(!linkDown)}>
          Link down
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
          <ModelPill old={false} />
          <SendButton
            empty={empty}
            running={running}
            canStop={running}
            blocked={linkDown ? "Waiting for the link to come back" : undefined}
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
        <Pair label="Empty">{(old) => <Card old={old} />}</Pair>
        <Pair label="Typing, with a mention chip">{(old) => <Card old={old} initial={draft("Look at ", mention, " and fix the Enter key")} />}</Pair>
        <Pair label="Multi-line">{(old) => <Card old={old} initial={draft("First line\nSecond line\nThird line")} />}</Pair>
        <Pair label="Scrolled: the top line fades">{(old) => <Card old={old} initial={draft(LONG)} scrolled />}</Pair>
        <Pair label="Turn running, empty: Stop">{(old) => <Card old={old} placeholder="Working for 2m 5s" running canStop />}</Pair>
        <Pair label="Turn running, typed: Send queues (tip Queue)">{(old) => <Card old={old} initial={draft("And add a test")} running canStop />}</Pair>
        <Pair label="Esc armed (tip Press Esc again to stop)">{(old) => <Card old={old} initial={draft("And add a test")} running canStop armed />}</Pair>
        <Pair label="Stopped: Resume">{(old) => <Card old={old} canResume />}</Pair>
        <Pair label="Link down: Send disabled">{(old) => <Card old={old} initial={draft("Kept while the link is down")} placeholder="Waiting for the link to come back" blocked="Waiting for the link to come back" />}</Pair>
        <Pair label="Context ring">{(old) => <Card old={old} ring />}</Pair>
      </Row>
      <Row name="Footer controls">
        {(["hover", "focus", "active"] as const).map((frozen) => (
          <Pair key={frozen} label={frozen} frozen={frozen}>
            {(old) => (
              <div className="flex items-center gap-1">
                {old ? <OldPlus /> : <PlusButton />}
                <PillDivider />
                <ModelPill old={old} />
                <SendButton keys={false} empty={false} running={false} canStop={false} onSend={noop} onStop={noop} />
              </div>
            )}
          </Pair>
        ))}
      </Row>
      <Row name="Edit and resend">
        <Pair label="Editing a sent message">
          {(old) => (
            <div className="w-full max-w-reading">
              {old ? <OldEdit /> : <EditComposer initial={draft("Fix the Enter key in the composer")} onCancel={noop} onSend={noop} />}
            </div>
          )}
        </Pair>
      </Row>
      <Row name="Live">
        <Live />
      </Row>
    </Section>
  );
}

/** Old app: the edit box's buttons in regular weight, Cancel a bordered ghost. */
function OldEdit() {
  return (
    <div className="flex flex-col px-2">
      <div className="ms-auto flex w-full flex-col gap-2 rounded-composer bg-composer p-2">
        <ComposerField initial={draft("Fix the Enter key in the composer")} placeholder="" label="Edit message" size="edit" />
        <div className="flex items-center justify-end gap-2">
          <BaseButton className="inline-flex h-control-sm items-center rounded-capsule border border-border px-2.5 text-sm hover:bg-fill">Cancel</BaseButton>
          <BaseButton className="inline-flex h-control-sm items-center rounded-capsule bg-primary px-2.5 text-sm text-primary-fg hover:bg-primary-hover">Send</BaseButton>
        </div>
      </div>
    </div>
  );
}
