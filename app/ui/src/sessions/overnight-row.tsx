import { type ReactNode, useContext, useState } from "react";

import { SessionOfThread } from "../accounts/limit";
import { Button } from "../components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { ActionOption } from "../components/composer/decision-parts";
import { cx } from "../components/cx";
import { RowText, SettingsCard } from "../components/settings-card";
import { Chevron } from "../components/thread/activity-row";
import { ThreadLine } from "../components/thread/line";
import { Check, Moon, QuestionMarkCircle, Shuffle, Sun, XCircleFilled } from "../icons";
import { openReview } from "../panel/open";
import { putBack } from "../session/side";
import type { Item } from "../thread/item";
import { Markdown } from "../thread/markdown";
import { duration, hhmm } from "../thread/words";

type OvernightItem = Extract<Item, { kind: "overnight" }>;
type Report = Extract<OvernightItem, { moment: "report" }>;

const MARK = "mt-0.5 size-icon-md shrink-0";

/** A part of a card: its mark, its words, opening to its proof. */
function Part({ mark, title, line, more, keep }: { mark: ReactNode; title: string; line?: string; more?: string | null; keep: string }) {
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
        <div className="px-4 ps-11 pb-3 text-label text-muted-foreground">
          <Markdown text={more} keep={keep} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A part with what can be done about it at its end. */
function ActionPart({ action, onAction, ...part }: Parameters<typeof Part>[0] & { action?: string | null; onAction?: () => void }) {
  if (!action || !onAction) return <Part {...part} />;
  return (
    <div className="flex items-center gap-3 pe-4">
      <div className="min-w-0 flex-1">
        <Part {...part} />
      </div>
      <Button size="sm" variant="soft" onClick={onAction}>
        {action}
      </Button>
    </div>
  );
}

function List({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <div>
      <p className="px-4 pt-3 pb-2 text-label text-muted-foreground">
        {title} <span className="tabular-nums">{count}</span>
      </p>
      <div className="settings-rows">{children}</div>
    </div>
  );
}

/** The morning: what is done and how it's known, what isn't, and each decision taken for the user and each question waiting, to follow up on. */
function Morning({ item, session }: { item: Report; session: string | undefined }) {
  // Into the composer, never sent: the user says more or sends it.
  const follow = (words: string) => session && putBack(session, words, true);
  // shortcut: picks show while the card is mounted; keep them on the item once Rust acts on one.
  const [changed, setChanged] = useState<readonly number[]>([]);
  const [answers, setAnswers] = useState<Readonly<Record<number, number>>>({});
  return (
    <>
      <ThreadLine icon={Sun}>
        Back at {hhmm(item.at)}, after {duration(item.ms)}
      </ThreadLine>
      <SettingsCard className="mt-5 rounded-overlay">
        <div className="sunrise flex flex-col gap-3 px-4 pt-6 pb-5">
          <div className="flex flex-col gap-1">
            <p className="font-display text-2xl">Good morning</p>
            <p className="text-sm text-timeline-title">{item.summary}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {session && <Button size="sm" onClick={() => openReview(session)}>Review changes</Button>}
            {item.url && (
              <Button size="sm" variant="outline" nativeButton={false} render={<a href={item.url} target="_blank" rel="noreferrer" />}>
                Try it
              </Button>
            )}
            <span className="text-xs text-muted-foreground">{item.facts.join(" · ")}</span>
          </div>
        </div>
        {item.done.length > 0 && (
          <List title="Done, with proof" count={item.done.length}>
            {item.done.map((each, at) => <Part key={at} keep={`${item.id}:done:${at}`} mark={<Check className={cx(MARK, "text-success")} />} title={each.title} line={each.proof} more={each.more} />)}
          </List>
        )}
        {item.left.length > 0 && (
          <List title="Not done" count={item.left.length}>
            {item.left.map((each, at) => <ActionPart key={at} keep={`${item.id}:left:${at}`} mark={<XCircleFilled className={cx(MARK, "text-warning")} />} title={each.title} line={each.why} action={each.next} onAction={() => follow(`${each.title}: ${each.next}`)} />)}
          </List>
        )}
        {item.decided.length > 0 && (
          <List title="Decided for you" count={item.decided.length}>
            {item.decided.map((each, at) => {
              const other = changed.includes(at);
              const toggle = () => {
                setChanged(other ? changed.filter((one) => one !== at) : [...changed, at]);
                follow(other ? `Keep “${each.title}” as you decided it.` : `You decided “${each.title}”. Change it to: ${each.other}`);
              };
              return <ActionPart key={at} keep={`${item.id}:decided:${at}`} mark={<Shuffle className={cx(MARK, "text-muted-foreground")} />} title={each.title} line={other ? `Changing to: ${each.other}` : each.why} action={each.other && (other ? "Keep" : each.other)} onAction={toggle} />;
            })}
          </List>
        )}
        {item.waiting.length > 0 && (
          <div className="pb-2">
            <p className="px-4 pt-3 pb-2 text-label text-muted-foreground">
              Waiting for you <span className="tabular-nums">{item.waiting.length}</span>
            </p>
            {item.waiting.map((each, at) => (
              <div key={at}>
                <div className="flex items-center gap-3 px-4 pb-2 text-label font-medium">
                  <QuestionMarkCircle className="size-icon-md shrink-0 text-link" />
                  {each.text}
                </div>
                <div role="radiogroup" aria-label={each.text} className="flex flex-col gap-1 ps-9 pe-2">
                  {each.options.map((option, index) => (
                    <ActionOption
                      key={option}
                      role="radio"
                      aria-checked={answers[at] === index}
                      number={index + 1}
                      name={option}
                      label={option}
                      recommended={each.recommended === index}
                      highlighted={answers[at] === index}
                      chosen={answers[at] === index}
                      onClick={() => {
                        if (answers[at] === index) return;
                        setAnswers({ ...answers, [at]: index });
                        follow(`${each.text} ${option}`);
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>
    </>
  );
}

/** Overnight's moments in the thread. */
export function OvernightRow({ item }: { item: OvernightItem }) {
  const session = useContext(SessionOfThread)?.id;
  return item.moment === "started" ? <ThreadLine icon={Moon}>Overnight since {hhmm(item.at)}</ThreadLine> : <Morning item={item} session={session} />;
}
