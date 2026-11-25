// A: Night sky. The pill is always beside Brigade's; on, the composer is the night. Questions one at a time on its rail,
// then Start night; in the morning, one card with the sun on it.
import { useState } from "react";

import { Button } from "../src/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../src/components/collapsible";
import { ActionCardActions, ActionOption } from "../src/components/composer/decision-parts";
import { QuestionCard } from "../src/components/composer/question";
import { RailItem } from "../src/components/composer/rail";
import { cx } from "../src/components/cx";
import { RowText, SettingsCard } from "../src/components/settings-card";
import { Chevron } from "../src/components/thread/activity-row";
import { ThreadLine } from "../src/components/thread/line";
import { WorkingLine } from "../src/components/thread/work";
import { showToast } from "../src/components/toast";
import { Check, Moon, QuestionMarkCircle, Shuffle, Sun, XCircleFilled } from "../src/icons";
import { nightLook as look, OvernightPill } from "../src/sessions/overnight-parts";
import { Markdown } from "../src/thread/markdown";
import { Brigade, DECIDED, DONE, FakeComposer, Hero, Level, MenuRoom, noop, NOT_DONE, OvernightMenu, Panel, PLAN, ProjectRail, QUESTIONS, RESEARCH, run, Says, Scene, Step, TASK, WAITING, You } from "./overnight-parts";


function NewChat() {
  const [on, setOn] = useState(true);
  return (
    <>
      <Hero />
      <FakeComposer
        look={look(on)}
        rail={<RailItem label="Composer utility bar"><ProjectRail /></RailItem>}
        placeholder={on ? "What should be done by morning?" : "Do anything"}
        pills={<><Level overnight={on} /><Brigade /><OvernightPill on={on} onChange={setOn} /></>}
      />
    </>
  );
}

function Running() {
  const [on, setOn] = useState(false);
  return (
    <Panel
      thread={<><You id="a-u1">{TASK}</You><Says id="a-a1">{PLAN}</Says><WorkingLine state="live">Reading the chat’s menu</WorkingLine>{!on && <MenuRoom />}</>}
      composer={
        <FakeComposer
          look={look(on)}
          running
          placeholder={on ? "It asks its last questions next" : "Do anything"}
          initial={on ? undefined : "/over"}
          key={String(on)}
          menu={!on && <OvernightMenu onPick={() => setOn(true)} />}
          pills={<><Level overnight={on} /><OvernightPill divider on={on} onChange={setOn} /></>}
        />
      }
    />
  );
}

function Asking() {
  const [answered, setAnswered] = useState(false);
  const [started, setStarted] = useState(false);
  const footer = (label: string) => (
    <ActionCardActions leading={<span className="min-w-0 flex-1 text-xs text-muted-foreground">{label}</span>}>
      <Button size="sm" onClick={() => setStarted(true)}>
        <Moon />
        Start night
      </Button>
    </ActionCardActions>
  );
  const rail = started ? null : (
    <RailItem variant="decision" label="Before you go">
      {answered ? (
        <>
          <div className="flex flex-col gap-1 px-4 pt-4">
            <p className="text-sm font-medium">That’s all I need</p>
            <p className="text-label text-muted-foreground">Full access until you’re back. Nothing is pushed or merged. I research, build, and have it reviewed until a round finds nothing.</p>
          </div>
          {footer("This Mac stays awake")}
        </>
      ) : (
        <QuestionCard question={QUESTIONS} session="mockup-a" run={run} onAnswer={async () => setAnswered(true)} onDismiss={noop} footer={footer("Or start now: it picks what you skip and tells you in the morning")} />
      )}
    </RailItem>
  );
  return (
    <Panel
      thread={<><Says id="a-a2">{PLAN}</Says>{started && <ThreadLine icon={Moon}>Overnight since 23:42</ThreadLine>}</>}
      composer={<FakeComposer look="night-sky" rail={rail} placeholder={started ? "Working until you’re back" : "Anything else before you go?"} pills={<><Level overnight /><OvernightPill divider on onChange={noop} /></>} />}
    />
  );
}

function Night() {
  return (
    <Panel
      thread={
        <>
          <ThreadLine icon={Moon}>Overnight since 23:42</ThreadLine>
          <Step kind="web" verb="Read" object="Obsidian’s import rules and 11 complaints about rival exports" />
          <Step kind="edit" verb="Edited" object="export.rs and chat-menu.tsx" />
          <Step kind="agent" verb="Had it reviewed" object="5 findings, 5 fixed" />
          <WorkingLine state="live">Reviewing again, round 2</WorkingLine>
        </>
      }
      composer={
        <FakeComposer
          look="night-sky"
          running
          placeholder="Working until you’re back"
          pills={<><Level overnight /><OvernightPill divider on onChange={noop} /></>}
          rail={
            <RailItem label="Overnight">
              <div className="flex items-center gap-2 px-3.5 py-2 text-sm">
                <Moon className="moonlit size-icon-md shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  3h 18m in <span className="text-muted-foreground">· 3 of 4 parts done · 2 decided for you</span>
                </span>
                <Button size="xs" variant="soft" onClick={() => showToast("It wraps up and writes the report")}>
                  I’m back
                </Button>
              </div>
            </RailItem>
          }
        />
      }
    />
  );
}

/** A part of the report: its mark, its words, opening to its proof. */
function Part({ mark, title, line, more }: { mark: React.ReactNode; title: string; line: string; more?: string }) {
  const body = (
    <>
      {mark}
      <RowText title={title} line={line} />
    </>
  );
  if (!more) return <div className="flex items-start gap-3 px-4 py-3">{body}</div>;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-start focus-visible:focus-ring">
        {body}
        <Chevron always />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-4 ps-11 pb-3 text-label text-muted-foreground"><Markdown text={more} keep={`a-${title}`} /></div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const MARK = "mt-0.5 size-icon-md shrink-0";
const Heading = ({ children, count }: { children: string; count: number }) => (
  <p className="px-4 pt-3 pb-2 text-label text-muted-foreground">
    {children} <span className="tabular-nums">{count}</span>
  </p>
);

function Morning() {
  const [changed, setChanged] = useState<string[]>([]);
  const [answer, setAnswer] = useState<number | null>(null);
  const waiting = WAITING.items[0]!;
  return (
    <Panel
      thread={
        <>
          <ThreadLine icon={Sun}>Back at 07:05, after 7h 23m</ThreadLine>
          <SettingsCard className="rounded-overlay">
            <div className="sunrise flex flex-col gap-3 px-4 pt-6 pb-5">
              <div className="flex flex-col gap-1">
                <p className="font-display text-2xl">Good morning</p>
                <p className="text-sm text-timeline-title">Export works and is ready to review. PDF isn’t done, and one question waits for you.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => showToast("Opens Changes")}>Review changes</Button>
                <Button size="sm" variant="outline" onClick={() => showToast("Opens the running app")}>Try it</Button>
                <span className="text-xs text-muted-foreground">+612 −88 in 14 files · {RESEARCH}</span>
              </div>
            </div>
            <div>
              <Heading count={DONE.length}>Done, with proof</Heading>
              <div className="settings-rows">
                {DONE.map((each) => <Part key={each.id} mark={<Check className={cx(MARK, "text-success")} />} title={each.title} line={each.proof} more={each.more} />)}
              </div>
            </div>
            <div>
              <Heading count={1}>Not done</Heading>
              <div className="flex items-center gap-3 pe-4">
                <div className="min-w-0 flex-1"><Part mark={<XCircleFilled className={cx(MARK, "text-warning")} />} title={NOT_DONE.title} line={NOT_DONE.why} /></div>
                <Button size="sm" variant="soft" onClick={() => showToast(NOT_DONE.next)}>{NOT_DONE.next}</Button>
              </div>
            </div>
            <div>
              <Heading count={DECIDED.length}>Decided for you</Heading>
              <div className="settings-rows">
                {DECIDED.map((each) => {
                  const other = changed.includes(each.id);
                  return (
                    <div key={each.id} className="flex items-center gap-3 pe-4">
                      <div className="min-w-0 flex-1"><Part mark={<Shuffle className={cx(MARK, "text-muted-foreground")} />} title={each.title} line={other ? `Changing to: ${each.other}` : each.why} /></div>
                      <Button size="sm" variant="soft" onClick={() => setChanged(other ? changed.filter((id) => id !== each.id) : [...changed, each.id])}>{other ? "Keep" : each.other}</Button>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="pb-2">
              <Heading count={1}>Waiting for you</Heading>
              <div className="flex items-center gap-3 px-4 pb-2 text-label font-medium">
                <QuestionMarkCircle className="size-icon-md shrink-0 text-link" />
                {waiting.text}
              </div>
              <div role="radiogroup" aria-label={waiting.text} className="flex flex-col gap-1 ps-9 pe-2">
                {waiting.options.map((option, index) => (
                  <ActionOption key={option.label} role="radio" aria-checked={answer === index} number={index + 1} name={option.label} label={option.label} recommended={waiting.recommended === index} highlighted={answer === index} chosen={answer === index} onClick={() => setAnswer(index)} />
                ))}
              </div>
            </div>
          </SettingsCard>
        </>
      }
      composer={<FakeComposer placeholder="Do anything" pills={<><Level overnight={false} /><OvernightPill divider on={false} onChange={noop} /></>} />}
    />
  );
}

export function VariantA() {
  return (
    <>
      <Scene title="New chat" note="Pill beside Brigade, always there; press it"><NewChat /></Scene>
      <Scene title="Running session" note="/overnight or the pill; press either"><Running /></Scene>
      <Scene title="Before you go" note="One question at a time, then Start night"><Asking /></Scene>
      <Scene title="Overnight" note="What you see if you look in"><Night /></Scene>
      <Scene title="Morning" note="One report card; rows open to their proof" tall><Morning /></Scene>
    </>
  );
}
