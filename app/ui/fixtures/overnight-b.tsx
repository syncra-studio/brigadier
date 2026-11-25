// B: Lights out. The pill is a lone moon until it's on; on, the whole window goes dark and quiet. Every question on one
// sheet with its pick already made, so you only change what's wrong; the night is its hours; the morning reads as a reply.
import { useState } from "react";

import { Button } from "../src/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../src/components/collapsible";
import { ComposerPill, PillDivider } from "../src/components/composer/composer";
import { ActionOption } from "../src/components/composer/decision-parts";
import { QuestionCard } from "../src/components/composer/question";
import { RailItem } from "../src/components/composer/rail";
import { cx } from "../src/components/cx";
import { Segmented } from "../src/components/segmented";
import { SettingsCard, RowText } from "../src/components/settings-card";
import { Chevron } from "../src/components/thread/activity-row";
import { ThreadLine } from "../src/components/thread/line";
import { WorkingLine } from "../src/components/thread/work";
import { Timeline } from "../src/components/timeline";
import { showToast } from "../src/components/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "../src/components/tooltip";
import { Markdown } from "../src/thread/markdown";
import { Brigade, DECIDED, DONE, FakeComposer, Hero, Level, Moon, MenuRoom, noop, NOT_DONE, OvernightMenu, Panel, PLAN, ProjectRail, QUESTIONS, RESEARCH, run, Says, Scene, Sun, TASK, WAITING, You } from "./overnight-parts";

const look = (on: boolean) => (on ? "lights-out" : undefined);

/** Off it's only its moon; on it opens into its name. */
function MoonPill({ on, onChange = noop, divider = false }: { on: boolean; onChange?: (on: boolean) => void; divider?: boolean }) {
  return (
    <>
      {divider && <PillDivider />}
      <Tooltip>
        <TooltipTrigger render={<ComposerPill aria-pressed={on} aria-label="Overnight" className="aria-pressed:bg-fill aria-pressed:text-foreground" onClick={() => onChange(!on)} />}>
          <Moon />
          {on && <span>Overnight</span>}
        </TooltipTrigger>
        <TooltipContent side="bottom">{on ? "Turn Overnight off" : "Overnight: it finishes the job while you’re away"}</TooltipContent>
      </Tooltip>
    </>
  );
}

function NewChat() {
  const [on, setOn] = useState(true);
  return (
    <Scene title="New chat" note="A moon beside Brigade; on, the window goes dark. Press it" look={look(on)}>
      <Hero />
      <FakeComposer
        rail={<RailItem label="Composer utility bar"><ProjectRail /></RailItem>}
        placeholder={on ? "What should be done when you’re back?" : "Do anything"}
        pills={<><Level overnight={on} /><Brigade /><MoonPill on={on} onChange={setOn} /></>}
      />
    </Scene>
  );
}

function Running() {
  const [on, setOn] = useState(false);
  return (
    <Scene title="Running session" note="/overnight or the moon; press either" look={look(on)}>
      <Panel
        thread={<><You id="b-u1">{TASK}</You><Says id="b-a1">{PLAN}</Says><WorkingLine state="live">Reading the chat’s menu</WorkingLine>{!on && <MenuRoom />}</>}
        composer={
          <FakeComposer
            key={String(on)}
            running
            placeholder={on ? "It asks its last questions next" : "Do anything"}
            initial={on ? undefined : "/over"}
            menu={!on && <OvernightMenu onPick={() => setOn(true)} />}
            pills={<><Level overnight={on} /><MoonPill divider on={on} onChange={setOn} /></>}
          />
        }
      />
    </Scene>
  );
}

function Asking() {
  const [picks, setPicks] = useState(QUESTIONS.items.map((item) => item.recommended ?? 0));
  const [started, setStarted] = useState(false);
  return (
    <Panel
      thread={
        <>
          <Says id="b-a2">{PLAN}</Says>
          {started ? (
            <ThreadLine icon={Moon}>Overnight since 23:42, 3 answers kept</ThreadLine>
          ) : (
            <SettingsCard className="rounded-overlay">
              <div className="flex flex-col gap-1 px-4 pt-4 pb-3">
                <p className="text-sm font-medium">Before you go</p>
                <p className="text-label text-muted-foreground">These are my picks. Change any, then go.</p>
              </div>
              {QUESTIONS.items.map((item, at) => (
                <div key={item.text} className="flex flex-col gap-1 px-4 py-3">
                  <p className="text-label font-medium">{item.text}</p>
                  <div role="radiogroup" aria-label={item.text} className="-mx-2 flex flex-col">
                    {item.options.map((option, index) => (
                      <ActionOption key={option.label} role="radio" aria-checked={picks[at] === index} number={index + 1} name={option.label} label={option.label} recommended={item.recommended === index} highlighted={picks[at] === index} chosen={picks[at] === index} onClick={() => setPicks(picks.map((pick, i) => (i === at ? index : pick)))} />
                    ))}
                  </div>
                </div>
              ))}
              <div className="flex items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1 text-xs text-muted-foreground">Full access until you’re back. Nothing is pushed unless you said so.</span>
                <Button size="sm" onClick={() => setStarted(true)}>
                  <Moon />
                  Start night
                </Button>
              </div>
            </SettingsCard>
          )}
        </>
      }
      composer={<FakeComposer placeholder={started ? "Working until you’re back" : "Or say it in your own words"} pills={<><Level overnight /><MoonPill divider on /></>} />}
    />
  );
}

function Night() {
  return (
    <Panel
      thread={
        <>
          <ThreadLine icon={Moon}>Overnight since 23:42</ThreadLine>
          <div className="dim transition-opacity">
            <Timeline
              events={[
                { id: "1", when: "past", time: "23:44", title: "Read how Obsidian imports, and 11 complaints about rival exports" },
                { id: "2", when: "past", time: "00:31", title: "Built the menu row and the writer", detail: "18 checks pass" },
                { id: "3", when: "past", time: "01:52", title: "Decided: files are named by title and date", detail: DECIDED[0]!.why },
                { id: "4", when: "past", time: "02:20", title: "Reviewed, round 1", detail: "5 findings, 5 fixed" },
                { id: "5", when: "now", time: "03:00", title: "Reviewing again, round 2" },
              ]}
            />
          </div>
        </>
      }
      composer={<FakeComposer running placeholder="Working until you’re back" pills={<><Level overnight /><MoonPill divider on /></>} />}
    />
  );
}

function Fold({ title, line, more }: { title: string; line: string; more: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-3 py-2 text-start focus-visible:focus-ring">
        <span className="min-w-0 flex-1 text-sm">
          {title} <span className="text-muted-foreground">· {line}</span>
        </span>
        <Chevron always />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pb-3 text-label text-muted-foreground"><Markdown text={more} keep={`b-${title}`} /></div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const Group = ({ title, tone, children }: { title: string; tone: string; children: React.ReactNode }) => (
  <section className={cx("flex flex-col border-s-2 ps-4", tone)}>
    <h3 className="pb-1 text-sm font-semibold">{title}</h3>
    {children}
  </section>
);

function Morning() {
  const [choice, setChoice] = useState<Record<string, "mine" | "other">>({});
  const [answered, setAnswered] = useState(false);
  return (
    <Panel
      thread={
        <>
          <ThreadLine icon={Sun}>Back at 07:05, after 7h 23m</ThreadLine>
          <Says id="b-a9">{`Export works and is ready to review: **14 files, +612 −88**. PDF isn’t done. ${RESEARCH}.`}</Says>
          <Group title="Done, with proof" tone="border-success">
            {DONE.map((each) => <Fold key={each.id} title={each.title} line={each.proof} more={each.more} />)}
          </Group>
          <Group title="Not done" tone="border-warning">
            <div className="flex items-center gap-3 py-2">
              <RowText title={NOT_DONE.title} line={NOT_DONE.why} />
              <Button size="sm" variant="soft" onClick={() => showToast(NOT_DONE.next)}>{NOT_DONE.next}</Button>
            </div>
          </Group>
          <Group title="Decided for you" tone="border-border">
            {DECIDED.map((each) => (
              <div key={each.id} className="flex flex-wrap items-center gap-3 py-2">
                <RowText title={each.title} line={each.why} />
                <Segmented label={each.title} value={choice[each.id] ?? "mine"} options={[{ value: "mine", label: "Keep" }, { value: "other", label: each.other }]} onChange={(value) => setChoice({ ...choice, [each.id]: value })} />
              </div>
            ))}
          </Group>
          <div><Button size="sm" onClick={() => showToast("Opens Changes")}>Review changes</Button></div>
        </>
      }
      composer={
        <FakeComposer
          placeholder="Do anything"
          rail={answered ? null : <RailItem variant="decision" label="Waiting for you"><QuestionCard question={{ ...WAITING, title: "Waiting for you" }} session="mockup-b" run={run} onAnswer={async () => setAnswered(true)} onDismiss={noop} /></RailItem>}
          pills={<><Level overnight={false} /><MoonPill divider on={false} /></>}
        />
      }
    />
  );
}

export function VariantB() {
  return (
    <>
      <NewChat />
      <Running />
      <Scene title="Before you go" note="One sheet, its picks already made; Start night is always one press" look="lights-out"><Asking /></Scene>
      <Scene title="Overnight" note="Hour by hour, dimmed until you hover" look="lights-out"><Night /></Scene>
      <Scene title="Morning" note="Reads as a reply; the waiting question sits at the composer" tall><Morning /></Scene>
    </>
  );
}
