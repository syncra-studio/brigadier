import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

import { SessionOfThread } from "../accounts/limit";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { CopyButton } from "../components/copy-button";
import { Chat, HandRaised } from "../icons";
import { daemonRun, sendMessage } from "../session/composer";

/**
 * A reply's cards [D477]: a fenced `brigadier-ask` or `brigadier-message` block holds JSON that Brigadier draws as its
 * own card. JSON that doesn't parse or doesn't fit draws nothing here, so the fence stays a code block.
 */
type Message = { to: string; state?: string; text: string; quote?: { from: string; text: string } };
type Ask = { question: string; recommend?: string; why?: string; answers: string[]; message?: Message };

const said = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const maybe = (value: unknown) => value === undefined || typeof value === "string";
const isMessage = (m: Record<string, any> | undefined): m is Message =>
  !!m && said(m.to) && said(m.text) && maybe(m.state) && (m.quote === undefined || (said(m.quote?.from) && said(m.quote?.text)));
const isAsk = (a: Record<string, any> | undefined): a is Ask =>
  !!a && said(a.question) && maybe(a.recommend) && maybe(a.why) && Array.isArray(a.answers) && a.answers.length > 0 && a.answers.length <= 4 && a.answers.every(said) && (a.message === undefined || isMessage(a.message));

/** The card a fence draws, or null when it isn't one. */
export function replyCard(language: string, json: string): ReactNode {
  if (language !== "brigadier-ask" && language !== "brigadier-message") return null;
  let spec: Record<string, any> | undefined;
  try {
    spec = JSON.parse(json);
  } catch {
    return null;
  }
  // Some agents give an ask's message as its text alone.
  if (language === "brigadier-ask" && typeof spec?.message === "string") spec = { ...spec, message: { to: "Message", text: spec.message } };
  if (language === "brigadier-ask") return isAsk(spec) ? <AskCard {...spec} /> : null;
  return isMessage(spec) ? <MessageCard {...spec} /> : null;
}

/** How a decision card answers: as the user's own message into the thread's session. None outside it. */
const Answer = createContext<((text: string) => void) | null>(null);

/** Lets the cards in `children` answer in the thread's session. */
export function Answers({ children }: { children: ReactNode }) {
  const id = useContext(SessionOfThread)?.id;
  const send = useMemo(() => (id ? (text: string) => void sendMessage(daemonRun, id, text) : null), [id]);
  return <Answer value={send}>{children}</Answer>;
}

const FRAME = "my-3 rounded-thread border border-border bg-code-surface first:mt-0 last:mb-0";

/** A question for the user with its answers as buttons; one click sends that answer as their reply. */
function AskCard({ question, recommend, why, answers, message }: Ask) {
  const answer = useContext(Answer);
  // shortcut: the pick is this card's own state, so drawn again (a reload) its buttons are live again; the reply sent shows below it.
  const [chosen, setChosen] = useState<string | null>(null);
  const lead = chosen ?? (recommend && answers.includes(recommend) ? recommend : answers[0]);
  return (
    <div className={`${FRAME} px-3.5 py-3`}>
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <HandRaised className="size-icon-sm" />
        Needs you
      </div>
      <div className="font-semibold">{question}</div>
      {recommend && (
        <div className="mt-1 text-muted-foreground">
          Recommended: <span className="text-foreground">{recommend}</span>
        </div>
      )}
      {why && <div className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{why}</div>}
      {message && (
        <div className="mt-3">
          <MessageCard {...message} />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {answers.map((each, n) => (
          <Button
            key={n}
            size="sm"
            variant={each === lead ? "default" : "soft"}
            disabled={!answer || chosen !== null}
            onClick={() => {
              setChosen(each);
              answer?.(each);
            }}
          >
            {each}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** A message for someone else: where it goes, whether it went, their words it answers, and copy for the message alone. */
function MessageCard({ to, state = "draft", text, quote }: Message) {
  return (
    <div className={FRAME}>
      <div className="flex h-control-md items-center gap-1.5 ps-3 pe-1.5 text-xs text-muted-foreground">
        <Chat className="size-icon-sm" />
        <span className="font-medium text-foreground">{to}</span>
        <Badge variant={state === "posted" ? "success" : "secondary"} className="ms-1">
          {state}
        </Badge>
        <CopyButton text={text} tooltip="Copy" copiedTooltip="Copied" size="icon-xs" className="ms-auto" />
      </div>
      {quote && (
        <div className="mx-3 mb-2 border-s-2 border-quote-edge ps-3 text-sm text-muted-foreground">
          <div className="text-xs font-medium">{quote.from} wrote</div>
          <div className="whitespace-pre-wrap">{quote.text}</div>
        </div>
      )}
      <div className="px-3 pb-3 leading-relaxed break-words whitespace-pre-wrap">{text}</div>
    </div>
  );
}
