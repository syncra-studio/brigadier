import { useEffect, useSyncExternalStore } from "react";

import type { Draft } from "../components/composer/draft";
import { ThinkingLine, UserBubble, datedAfter } from "../components/thread/message";
import { threadSource } from "../daemon";
import { sendFailed } from "../thread/follow";
import type { Source } from "../thread/thread";
import type { Chip } from "../panel/chips";
import { daemonRun, failure, type Runner } from "./composer";
import { resyncDraft, takeBack } from "./draft";
import { inThread } from "./queued";
import { newId } from "./store";

/*
 * Messages sent at once or steered, shown in the thread at once [D30]. A message goes under its command id, so trying
 * it again can't send it twice (the host drops a repeated id). It settles when Rust's thread has it under that id: a
 * sent one's turn, a steer's message. One that surely never reached the log Rust gives back into the draft, with the
 * field's draft it was sent from (`draft`, its revision then `rev`) and its chips; any other refusal stays, with Try
 * again [D363, D54].
 */
export type Sent = { cid: string; text: string; parts?: string; steer: boolean; at: number; retryOf?: string; error?: string; draft?: Draft; rev?: number | null; chips?: readonly Chip[] };

/** What a message carries for Rust to give it back by. */
export const draftArgs = (draft: Draft | undefined, rev: number | null) => (draft ? ["--draft", JSON.stringify(draft), ...(rev === null ? [] : ["--draft-rev", String(rev)])] : []);
let sent = new Map<string, Sent[]>();
const sentListeners = new Set<() => void>();
export function setSent(id: string, change: (list: Sent[]) => Sent[]): void {
  sent = new Map(sent).set(id, change(sent.get(id) ?? []));
  for (const listener of sentListeners) listener();
}
const subscribeSent = (listener: () => void) => {
  sentListeners.add(listener);
  return () => sentListeners.delete(listener);
};

export function deliver(run: Runner, id: string, message: Sent): Promise<void> {
  const args = ["send", id, message.text, "--cid", message.cid];
  if (message.retryOf) args.push("--retry-of", message.retryOf);
  if (message.parts) args.push("--parts", message.parts);
  args.push(...draftArgs(message.draft, message.rev ?? null));
  const fail = (error: string) => {
    setSent(id, (list) => list.map((each) => (each.cid === message.cid ? { ...each, error } : each)));
    sendFailed(message.cid);
  };
  const given = (reply: Record<string, any>) => {
    setSent(id, (list) => list.filter((each) => each.cid !== message.cid));
    // Given back before (`again`), it's in the draft already, or comes with a save now.
    if (reply.again) return resyncDraft(run, id);
    takeBack(run, id, { cid: message.cid, parts: reply.parts, attachmentIds: reply.attachmentIds, chips: message.chips?.length ? message.chips : reply.chips, error: failure(reply) });
  };
  // Logged: the thread shows the turn and how it ended, so the message has its place there.
  return run(message.steer ? [...args, "--steer"] : args).then((reply) => void (reply.ok || reply.result === "logged" || (reply.given_back ? given(reply) : fail(failure(reply)))), (cause) => fail(String(cause)));
}

/** A message sent from outside the composer, with its pending bubble and command-id recovery: the retry after a rewind (`retryOf`).
 * Not the field's words, so its revision is none: going or given back, it never clears what the field holds. */
export function sendMessage(run: Runner, id: string, text: string, retryOf?: string, draft?: Draft | null): Promise<void> {
  const entry: Sent = { cid: newId(), text, parts: draft ? JSON.stringify(draft) : undefined, steer: false, at: Date.now(), retryOf, draft: draft ?? { parts: [text], attachmentIds: [] }, rev: null };
  setSent(id, (list) => [...list, entry]);
  return deliver(run, id, entry);
}

/** Whether the session has messages on their way (so the thread's footer shows them); `useOnItsWay` counts none refused, which wait on Try again, so nothing spins for them. */
export const useSending = (id: string) => useSyncExternalStore(subscribeSent, () => (sent.get(id)?.length ?? 0) > 0);
export const useOnItsWay = (id: string) => useSyncExternalStore(subscribeSent, () => sent.get(id)?.some((each) => !each.error) ?? false);

/** The messages on their way, under the thread's last row. */
export function SentBubbles({ id, source = threadSource, run = daemonRun, hover = false }: { id: string; source?: Source; run?: Runner; /** Actions only on hover: the worker panel's, whose rows draw none. */ hover?: boolean }) {
  const list = useSyncExternalStore(subscribeSent, () => sent.get(id));
  const session = useSyncExternalStore(source.subscribe, source.get);
  const done = (each: Sent) => inThread(session).has(each.cid);
  useEffect(() => {
    if (list?.some(done)) setSent(id, (now) => now.filter((each) => !done(each)));
  });
  const shown = list?.filter((each) => !done(each)) ?? [];
  if (shown.length === 0) return null;
  // Dated as their rows will be (after the thread's last message, or the bubble before), so a row takes its place without a shift.
  let previous: { sentAt?: number } | undefined = session?.items.findLast((item) => item.kind === "message");
  return (
    // In the thread's footer (its pt-3 under rows, pt-8 as the first row), Rust's rows' gaps (rows.tsx) and Thinking 12 under, so a row takes a bubble's place without a shift.
    <div className="flex flex-col gap-6 pt-2 in-data-footer:gap-8 in-data-first:pt-0 in-data-rows:pt-5">
      {shown.map((each) => {
        const dated = datedAfter(previous, each.at);
        previous = { sentAt: each.at };
        return (
          <UserBubble
            key={each.cid}
            keep={each.cid}
            text={each.text}
            time={each.at} older={hover || each !== shown.at(-1)}
            dated={dated}
            owner={id}
            parts={each.parts ? (JSON.parse(each.parts) as Draft).parts : undefined}
            failed={each.error}
            onRetry={() => {
              const again = { ...each, error: undefined };
              setSent(id, (now) => now.map((one) => (one.cid === each.cid ? again : one)));
              deliver(run, id, again);
            }}
            onDiscard={() => setSent(id, (now) => now.filter((one) => one.cid !== each.cid))}
          />
        );
      })}
      {!shown.at(-1)!.error && <div className="in-data-footer:-mt-5"><ThinkingLine /></div>}
    </div>
  );
}
