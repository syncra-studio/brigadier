import { createContext, type FC, type ReactNode, useContext } from "react";

import { cx } from "../components/cx";
import { ROW } from "../components/thread/activity-row";
import { Chat, Clock } from "../icons";
import { Markdown } from "../thread/markdown";
import { OpeningLine } from "../workers/sentence";
import { type Exchange, exchangeWords, type PeerRef, type SessionSendState, sessionSendWords, type Status, UNKNOWN_SESSION, type WordPart } from "./words";

/*
 * The sender's rows of its messages to other sessions and its waits for their replies, as the old app's PeerRow and
 * PeerLink [D3014]: one line each, "Sending message to Docs", then "Waiting for Docs to reply", then "Sent message to
 * Docs, waited for its reply". Each name opens that session at the message. Plus the hop limit's row [D2034].
 */

/** Opens a session, at a message once it has it. */
export const PeerOpen = createContext<(session: string, message?: string) => void>(() => {});

/** A session a row names: a button that opens it. */
export const PeerLink: FC<{ peer: PeerRef }> = ({ peer }) => {
  const open = useContext(PeerOpen);
  return (
    <button
      type="button"
      data-slot="peer-link"
      title={`Open ${peer.title}`}
      onClick={(event) => {
        event.stopPropagation();
        open(peer.session, peer.message);
      }}
      className="cursor-pointer rounded-control align-bottom text-row-object hover:text-foreground focus-visible:text-foreground focus-visible:focus-ring"
    >
      {peer.title}
    </button>
  );
};

/** A row's words, each session it names a link to it. */
const PeerWords: FC<{ parts: readonly WordPart[]; running: boolean }> = ({ parts, running }) => (
  <span data-slot="peer-words" className="min-w-0 truncate">
    {parts.map((part, index) =>
      typeof part === "string" ? (
        <span key={index} className={cx(running && "shimmer")}>
          {part}
        </span>
      ) : part.gone ? (
        <span key={index} className="text-row-object">
          {part.title}
        </span>
      ) : (
        <PeerLink key={index} peer={part} />
      ),
    )}
  </span>
);

/** A sent message's row, opening to the whole of it; with none (or no `keep`), only its line. */
const SentLine: FC<{ keep?: string; text?: string; state?: string; title?: string; children: ReactNode }> = ({ keep, text, state, title, children }) => (
  <div data-slot="orchestrator-step" data-kind="message" data-state={state} title={title}>
    {keep && text ? (
      <OpeningLine keep={keep} detail={<div data-slot="sent-message" className="select-text"><Markdown text={text} keep={`${keep}:text`} /></div>}>
        {children}
      </OpeningLine>
    ) : (
      <div className={ROW}>{children}</div>
    )}
  </div>
);

/** One row of messages and waits: a clock while it waits, why a message didn't go in its tooltip. */
export const PeerSentRow: FC<{ keep?: string; text?: string; exchange: Exchange }> = ({ keep, text, exchange }) => {
  const { parts, status, waiting } = exchangeWords(exchange);
  const Icon = waiting ? Clock : Chat;
  const reasons = exchange.sends.flatMap((send) => (send.state.type === "refused" || send.state.type === "dropped" ? [send.state.reason] : []));
  return (
    <SentLine keep={keep} text={text} title={reasons.length > 0 ? reasons.join("\n") : undefined}>
      <Icon aria-hidden className="size-4 shrink-0" />
      <PeerWords parts={parts} running={status === "inProgress"} />
    </SentLine>
  );
};

/** The thread's own `brigadier wait` on other sessions: "Waiting for Docs to reply", then "Received a reply from Docs", opening to the reply. */
export const SessionWaitRow: FC<{ keep: string; to: readonly PeerRef[]; replies: readonly (PeerRef & { text: string })[]; status: Status }> = ({ keep, to, replies, status }) => {
  const { parts, status: shown, waiting } = exchangeWords({
    sends: [],
    // A reply taken ends it, whatever its call still says.
    waits: [replies.length > 0 ? "completed" : status],
    received: replies,
    waitingOn: to,
  });
  const line: ReactNode = (
    <>
      {waiting ? <Clock aria-hidden className="size-4 shrink-0" /> : <Chat aria-hidden className="size-4 shrink-0" />}
      <PeerWords parts={parts} running={shown === "inProgress"} />
    </>
  );
  if (replies.length === 0) return <div data-slot="orchestrator-step" data-kind="message" className={ROW}>{line}</div>;
  return (
    <OpeningLine
      keep={keep}
      detail={
        <div data-slot="wait-replies" className="flex flex-col gap-2">
          {replies.map((reply, index) => (
            <Markdown key={index} text={reply.text} keep={`${keep}:${index}`} />
          ))}
        </div>
      }
    >
      {line}
    </OpeningLine>
  );
};

/** A send refused before anything was recorded: "Couldn't send message to ‹name›", why in its tooltip. */
export const PeerRefusedRow: FC<{ to: PeerRef | null; reason: string }> = ({ to, reason }) => (
  <div data-slot="orchestrator-step" data-kind="message" data-state="refused" className={ROW} title={reason}>
    <Chat aria-hidden className="size-4 shrink-0" />
    <span data-slot="peer-words" className="min-w-0 truncate">
      Couldn’t send message to {to && !to.gone ? <PeerLink peer={to} /> : <span className="text-row-object">{to?.title ?? UNKNOWN_SESSION}</span>}
    </span>
  </div>
);

/**
 * The thread's own `brigadier send` to another session: "Messaging Docs" while it runs, then "Messaged Docs: Can you
 * check the schema?", the message a step fainter and cut to the line, opening to the whole of it.
 */
export const SessionSentRow: FC<{ keep?: string; to: PeerRef | null; state: SessionSendState; text?: string; refused?: string }> = ({ keep, to, state, text, refused }) => (
  <SentLine keep={keep} text={text} state={state} title={refused}>
    <Chat aria-hidden className="size-4 shrink-0" />
    <span data-slot="peer-words" className="flex min-w-0 items-baseline overflow-hidden whitespace-pre">
      <span className={cx("shrink-0", state === "sending" && "shimmer")}>{sessionSendWords(state)}</span>
      <span className="shrink-0">
        {to && !to.gone ? <PeerLink peer={to} /> : <span className="text-row-object">{to?.title ?? UNKNOWN_SESSION}</span>}
        {state === "sent" && text ? ": " : null}
      </span>
      {state === "sent" && text ? <span data-slot="peer-sent-text" className="min-w-0 flex-1 truncate text-row-object">{text.split("\n", 1)[0]}</span> : null}
    </span>
  </SentLine>
);

/** A message the 9th hop of a chain between sessions would have sent: held, and only the user lets it through [D2034]. */
export const HopStopRow: FC<{ onSend: () => void; words?: string }> = ({ onSend, words = "Stopped after 8 hops" }) => (
  <div data-slot="orchestrator-step" data-kind="message" data-state="hops" className={ROW}>
    <Chat aria-hidden className="size-4 shrink-0" />
    <span className="min-w-0 truncate">
      {words}
      <span aria-hidden className="text-row-object"> · </span>
      <button type="button" onClick={onSend} className="cursor-pointer rounded-control text-strip-foreground hover:text-foreground focus-visible:focus-ring">
        Send anyway
      </button>
    </span>
  </div>
);
