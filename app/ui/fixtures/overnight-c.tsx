// C: Handover. The card keeps its fill and gets a moonlit edge; its send button becomes Start night once the agent's
// checklist on the rail is settled. In the morning the report is a list you clear, opening on what needs you.
import { useState } from "react";

import { Button } from "../src/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../src/components/collapsible";
import { ActionOption } from "../src/components/composer/decision-parts";
import { RailItem } from "../src/components/composer/rail";
import { cx } from "../src/components/cx";
import { Segmented } from "../src/components/segmented";
import { RowText, SettingsCard } from "../src/components/settings-card";
import { Chevron } from "../src/components/thread/activity-row";
import { ThreadLine } from "../src/components/thread/line";
import { WorkingLine } from "../src/components/thread/work";
import { showToast } from "../src/components/toast";
import { Check, CheckCircle, QuestionMarkCircle, Shuffle, XCircleFilled } from "../src/icons";
import { Markdown } from "../src/thread/markdown";
import { Brigade, DECIDED, DONE, FakeComposer, Hero, Level, MenuRoom, Moon, noop, NOT_DONE, OvernightMenu, OvernightPill, Panel, PLAN, ProjectRail, QUESTIONS, RESEARCH, Says, Scene, Step, Sun, TASK, WAITING, You } from "./overnight-parts";

const pill = (on: boolean) => cx("aria-pressed:bg-fill", on && "moonlit-blue");
const look = (on: boolean) => (on ? "moon-edge" : undefined);

function NewChat() {
  const [on, setOn] = useState(true);
  return (
    <>
      <Hero />
      <FakeComposer
        look={look(on)}
        rail={<RailItem label="Composer utility bar"><ProjectRail /></RailItem>}
        placeholder={on ? "Hand over the job" : "Do anything"}
        pills={<><Level overnight={on} /><Brigade /><OvernightPill on={on} onChange={setOn} className={pill(on)} /></>}
      />
    </>
  );
}

function Running() {
  const [on, setOn] = useState(false);
  return (
    <Panel
      thread={<><You id="c-u1">{TASK}</You><Says id="c-a1">{PLAN}</Says><WorkingLine state="live">Reading the chat’s menu</WorkingLine>{!on && <MenuRoom />}</>}
      composer={
        <FakeComposer
          key={String(on)}
          look={look(on)}
          running
          placeholder={on ? "It hands you its checklist next" : "Do anything"}
          initial={on ? undefined : "/over"}
          menu={!on && <OvernightMenu onPick={() => setOn(true)} />}
          pills={<><Level overnight={on} /><OvernightPill divider on={on} onChange={setOn} className={pill(on)} /></>}
        />
      }
    />
  );
}

function Asking() {
  const [picks, setPicks] = useState<(number | null)[]>([0, null, null]);
  const [open, setOpen] = useState<number | null>(1);
  const [started, setStarted] = useState(false);
  const left = picks.filter((pick) => pick === null).length;
  const pick = (at: number, index: number) => {
    const next = picks.map((each, i) => (i === at ? index : each));
    setPicks(next);
    const following = next.indexOf(null);
    setOpen(following < 0 ? null : following);
  };
  return (
    <Panel
      thread={<><Says id="c-a2">{PLAN}</Says>{started && <ThreadLine icon={Moon}>Handed over at 23:42</ThreadLine>}</>}
      composer={
        <FakeComposer
          look="moon-edge"
          placeholder={started ? "Working until you’re back" : "Anything else it should know?"}
          pills={<><Level overnight /><OvernightPill divider on onChange={noop} className={pill(true)} /></>}
          send={
            started ? undefined : (
              <Button size="sm" onClick={() => setStarted(true)}>
                <Moon />
                Start night
              </Button>
            )
          }
          rail={
            started ? null : (
              <RailItem label="Handover">
                <div className="flex flex-col gap-1 px-2 py-3">
                  <p className="flex items-baseline gap-2 px-2 pb-1 text-label text-muted-foreground">
                    <span className="flex-1">Handover</span>
                    {left ? `${left} to answer; it picks what you leave` : "All answered"}
                  </p>
                  {QUESTIONS.items.map((item, at) => {
                    const chosen = picks[at] ?? null;
                    return (
                      <Collapsible key={item.text} open={open === at} onOpenChange={(next) => setOpen(next ? at : null)}>
                        <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2.5 rounded-surface px-2 py-1.5 text-start text-sm hover:bg-fill-subtle focus-visible:focus-ring">
                          {chosen === null ? <QuestionMarkCircle className="size-icon-md shrink-0 text-muted-foreground" /> : <CheckCircle className="moonlit-blue size-icon-md shrink-0" />}
                          <span className="min-w-0 flex-1 truncate">{item.text}</span>
                          {chosen !== null && <span className="truncate text-muted-foreground">{item.options[chosen]!.label}</span>}
                          <Chevron always />
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <div role="radiogroup" aria-label={item.text} className="flex flex-col ps-7 pb-1">
                            {item.options.map((option, index) => (
                              <ActionOption key={option.label} role="radio" aria-checked={chosen === index} number={index + 1} name={option.label} label={option.label} recommended={item.recommended === index} highlighted={chosen === index} chosen={chosen === index} onClick={() => pick(at, index)} />
                            ))}
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                    );
                  })}
                </div>
              </RailItem>
            )
          }
        />
      }
    />
  );
}

function Night() {
  return (
    <Panel
      thread={
        <>
          <ThreadLine icon={Moon}>Handed over at 23:42</ThreadLine>
          <Step kind="web" verb="Read" object="Obsidian’s import rules and 11 complaints about rival exports" />
          <Step kind="agent" verb="Had it reviewed" object="5 findings, 5 fixed" />
          <WorkingLine state="live">Reviewing again, round 2</WorkingLine>
        </>
      }
      composer={
        <FakeComposer
          look="moon-edge"
          running
          placeholder="Working until you’re back"
          pills={<><Level overnight /><OvernightPill divider on onChange={noop} className={pill(true)} /></>}
          rail={
            <RailItem label="Handover">
              <div className="flex flex-col gap-1.5 px-4 py-3 text-sm">
                {DONE.map((each, at) => (
                  <span key={each.id} className={cx("flex items-center gap-2.5", at === 3 && "text-muted-foreground")}>
                    {at < 3 ? <CheckCircle className="moonlit-blue size-icon-md shrink-0" /> : <Moon className="size-icon-md shrink-0" />}
                    {at < 3 ? each.title : "Reviewing it against itself, round 2"}
                  </span>
                ))}
              </div>
            </RailItem>
          }
        />
      }
    />
  );
}

const MARK = "mt-0.5 size-icon-md shrink-0";
type Tab = "you" | "done" | "not" | "decided";

function Morning() {
  const [tab, setTab] = useState<Tab>("you");
  const [answer, setAnswer] = useState<number | null>(null);
  const [seen, setSeen] = useState<string[]>([]);
  const waiting = WAITING.items[0]!;
  const toggle = (id: string) => setSeen(seen.includes(id) ? seen.filter((each) => each !== id) : [...seen, id]);
  return (
    <Panel
      thread={
        <>
          <ThreadLine icon={Sun}>Back at 07:05, after 7h 23m</ThreadLine>
          <Says id="c-a9">{`Export works and is ready to review. PDF isn’t done. ${RESEARCH}.`}</Says>
          <SettingsCard className="rounded-overlay">
            <div className="flex flex-wrap items-center gap-3 p-3">
              <Segmented
                label="Report"
                value={tab}
                onChange={setTab}
                options={[
                  { value: "you", label: `Waiting for you ${answer === null ? 1 : 0}` },
                  { value: "done", label: `Done ${DONE.length}` },
                  { value: "not", label: "Not done 1" },
                  { value: "decided", label: `Decided for you ${DECIDED.length}` },
                ]}
              />
              <Button className="ms-auto" size="sm" onClick={() => showToast("Opens Changes")}>Review changes</Button>
            </div>
            {tab === "you" && (
              <div className="flex flex-col gap-2 p-4">
                <p className="flex items-center gap-2.5 text-sm font-medium"><QuestionMarkCircle className="size-icon-md text-link" />{waiting.text}</p>
                <div role="radiogroup" aria-label={waiting.text} className="flex flex-col ps-5">
                  {waiting.options.map((option, index) => (
                    <ActionOption key={option.label} role="radio" aria-checked={answer === index} number={index + 1} name={option.label} label={option.label} recommended={waiting.recommended === index} highlighted={answer === index} chosen={answer === index} onClick={() => setAnswer(index)} />
                  ))}
                </div>
              </div>
            )}
            {tab === "done" &&
              DONE.map((each) => (
                <Collapsible key={each.id}>
                  <CollapsibleTrigger className="group flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-start focus-visible:focus-ring">
                    <Check className={cx(MARK, "text-success")} />
                    <RowText title={each.title} line={each.proof} />
                    <Chevron always />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="px-4 ps-11 pb-3 text-label text-muted-foreground"><Markdown text={each.more} keep={`c-${each.id}`} /></div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            {tab === "not" && (
              <div className="flex items-start gap-3 px-4 py-3">
                <XCircleFilled className={cx(MARK, "text-warning")} />
                <RowText title={NOT_DONE.title} line={NOT_DONE.why} />
                <Button size="sm" variant="soft" onClick={() => showToast(NOT_DONE.next)}>{NOT_DONE.next}</Button>
              </div>
            )}
            {tab === "decided" &&
              DECIDED.map((each) => (
                <div key={each.id} className="flex items-center gap-3 px-4 py-3">
                  <Shuffle className={cx(MARK, "text-muted-foreground")} />
                  <RowText title={each.title} line={seen.includes(each.id) ? `Changing to: ${each.other}` : each.why} />
                  <Button size="sm" variant="soft" onClick={() => toggle(each.id)}>{seen.includes(each.id) ? "Keep" : each.other}</Button>
                </div>
              ))}
          </SettingsCard>
        </>
      }
      composer={<FakeComposer placeholder="Do anything" pills={<><Level overnight={false} /><OvernightPill divider on={false} onChange={noop} className={pill(false)} /></>} />}
    />
  );
}

export function VariantC() {
  return (
    <>
      <Scene title="New chat" note="Pill beside Brigade; on, the card’s edge is moonlit. Press it"><NewChat /></Scene>
      <Scene title="Running session" note="/overnight or the pill; press either"><Running /></Scene>
      <Scene title="Before you go" note="A checklist on the rail; Start night sits where Send does"><Asking /></Scene>
      <Scene title="Overnight" note="The same checklist, ticking off"><Night /></Scene>
      <Scene title="Morning" note="One report in four tabs, opening on what waits for you"><Morning /></Scene>
    </>
  );
}
