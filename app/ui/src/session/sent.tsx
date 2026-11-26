import { useEffect, useSyncExternalStore } from "react";

import { type Draft, plainText } from "../components/composer/draft";
import { ThinkingLine, UserBubble, datedAfter } from "../components/thread/message";
import { threadSource, view } from "../daemon";
import { sendFailed } from "../thread/follow";
import type { Source } from "../thread/thread";
import type { Chip } from "../panel/chips";
import { daemonRun, failure, type Runner } from "./composer";
import { keptChipsBack, resyncDraft, takeBack } from "./draft";
import { inThread } from "./queued";
import { newId } from "./store";
import { flagOf, forget, type Going, keepGoing, markGoing, tellDrops, UNCONFIRMED, useGoingOf } from "./uncertain";

/*
 * Messages sent at once or steered, shown in the thread at once [D30], and the actions on every message on its way
 * (uncertain.ts). A message goes under its command id, so trying it again can't send it twice (the host drops a
 * repeated id). It settles when Rust's thread has it under that id: a sent one's turn, a steer's message. One Rust
 * gives back comes into the draft, with the field's draft it was sent from and its chips; one Rust can't say of stays,
 * with Try again, Discard and Edit [D363, D54].
 */

/** What a message carries for Rust to give it back by. */
export const draftArgs = (draft: Draft | undefined, rev: number | null) => (draft ? ["--draft", JSON.stringify(draft), ...(rev === null ? [] : ["--draft-rev", String(rev)])] : []);
/** The chips a message takes as it goes. */
export const chipArgs = (chips: readonly Chip[] = []) => (chips.length > 0 ? ["--chips", chips.map((chip) => chip.id).join(",")] : []);
/** A send's command, as Rust keeps it to try again. */
export const sendOp = (id: string, text: string, cid: string, how: { parts?: string; steer?: boolean; retryOf?: string; chips?: readonly Chip[] }) =>
  ["send", id, text, "--cid", cid, ...(how.retryOf ? ["--retry-of", how.retryOf] : []), ...(how.parts ? ["--parts", how.parts] : []), ...(how.steer ? ["--steer"] : []), ...chipArgs(how.chips)];

// The connection each message went on, or was last handed over on: only a later one hands it to Rust again.
const asked = new Map<string, unknown>();

/** Message `entry` kept here as it goes on this connection, before the field empties. */
export function keep(id: string, entry: Going): Going {
  asked.set(entry.cid, view.daemon);
  return keepGoing(id, entry);
}

/** Message `entry` goes: kept here first, so a reload loses nothing, then run with the draft it came from and the field's revision then. */
export function go(run: Runner, id: string, entry: Going, rev: number | null): Promise<void> {
  keep(id, entry);
  return run([...entry.op, ...draftArgs(entry.draft, rev)]).then(
    (reply) => answered(run, id, entry, reply),
    (cause) => markGoing(id, entry.cid, { stuck: String(cause) }),
  );
}

/** What Rust's reply says of message `entry`: given back into the draft, gone where it went, or held by Rust's book unsettled; no reply, it stays kept here. */
export function answered(run: Runner, id: string, entry: Going, reply: Record<string, any>): void {
  if (entry.kind === "send" && !reply.ok) sendFailed(entry.cid);
  if (reply.given_back) {
    forget(id, entry.cid);
    // Given back before (`again`), it's in the draft already, or comes with a save now.
    if (reply.again) return resyncDraft(run, id);
    return takeBack(run, id, { cid: entry.cid, parts: reply.parts, attachmentIds: reply.attachmentIds, chips: reply.chips?.length ? reply.chips : entry.chips, error: failure(reply) });
  }
  // Logged: the thread shows the turn and how it ended; a queue add that went is Rust's queue's row.
  const went = reply.ok || reply.logged === true || reply.result === "logged";
  if (went && entry.kind === "queue") return void forget(id, entry.cid);
  markGoing(id, entry.cid, { booked: entry.booked || went || reply.unsettled === true, reached: reply.unsettled ? true : entry.reached, stuck: went ? undefined : failure(reply) });
}

/** The app's copy to Rust (`adopt`): Rust's from now on, unless the draft or the session has it already. */
function adopt(run: Runner, id: string, entry: Going): Promise<Record<string, any>> {
  return run(["draft", id, "adopt", entry.cid, "--kind", entry.kind, "--op", JSON.stringify(entry.op), "--draft", JSON.stringify(entry.draft)]).then((reply) => {
    // Given back, its chips wait again: the draft's read can't release them once it's forgotten.
    if (reply.given_back) keptChipsBack(id, entry);
    if (reply.ok && !reply.kept) forget(id, entry.cid);
    if (reply.given_back) resyncDraft(run, id);
    if (reply.kept) markGoing(id, entry.cid, { booked: true, reached: reply.reached === true, stuck: entry.stuck || UNCONFIRMED });
    return reply;
  });
}

/** Try again or Add again: Rust runs the message's own command again under its id (`retry`), once its book has it. */
export async function again(run: Runner, id: string, entry: Going): Promise<void> {
  markGoing(id, entry.cid, { stuck: undefined });
  const adopted = entry.booked ? { kept: true } : await adopt(run, id, entry);
  if (adopted.kept) return answered(run, id, { ...entry, booked: true }, await run(["draft", id, "retry", entry.cid]));
  if (!adopted.ok) markGoing(id, entry.cid, { stuck: failure(adopted) });
}

/** Discard, Delete or Edit: Rust takes the message out wherever it waits (`drop`), now or once it answers again; Edit brings its words back at once, as a new message. */
export function discard(run: Runner, id: string, entry: Going, edit = false): void {
  markGoing(id, entry.cid, { removing: true });
  if (edit) takeBack(run, id, { cid: newId(), ...entry.draft });
  void tellDrops(run, id);
}

/** Session `id`'s messages Rust may not hold, handed to it on each new connection, a Delete told instead. */
export function useHanding(id: string, daemon: unknown, run: Runner): void {
  const mine = useGoingOf(id);
  useEffect(() => {
    if (!daemon) return;
    for (const each of mine.filter((one) => (!one.booked || one.removing) && asked.get(one.cid) !== daemon)) {
      asked.set(each.cid, daemon);
      void (each.removing ? tellDrops(run, id) : adopt(run, id, each));
    }
  });
}

/** A message sent from outside the composer, with its pending bubble and command-id recovery: the retry after a rewind (`retryOf`).
 * Not the field's words, so its revision is none: going or given back, it never clears what the field holds. */
export function sendMessage(run: Runner, id: string, text: string, retryOf?: string, draft?: Draft | null): Promise<void> {
  const cid = newId();
  const op = sendOp(id, text, cid, { parts: draft ? JSON.stringify(draft) : undefined, retryOf });
  return go(run, id, { cid, kind: "send", op, draft: draft ?? { parts: [text], attachmentIds: [] }, at: Date.now() }, null);
}

const sends = (list: readonly Going[]) => list.filter((each) => each.kind === "send" && !each.removing);
/** Whether the session has messages on their way (so the thread's footer shows them); `useOnItsWay` counts none stuck, which wait on Try again, so nothing spins for them. */
export const useSending = (id: string) => sends(useGoingOf(id)).length > 0;
export const useOnItsWay = (id: string) => sends(useGoingOf(id)).some((each) => each.stuck === undefined);

/** The messages on their way, under the thread's last row. */
export function SentBubbles({ id, source = threadSource, run = daemonRun, hover = false }: { id: string; source?: Source; run?: Runner; /** Actions only on hover: the worker panel's, whose rows draw none. */ hover?: boolean }) {
  const list = sends(useGoingOf(id));
  const session = useSyncExternalStore(source.subscribe, source.get);
  const done = (each: Going) => inThread(session).has(each.cid);
  useEffect(() => {
    for (const each of list.filter(done)) forget(id, each.cid);
  });
  const shown = list.filter((each) => !done(each));
  if (shown.length === 0) return null;
  // Dated as their rows will be (after the thread's last message, or the bubble before), so a row takes its place without a shift.
  let previous: { sentAt?: number } | undefined = session?.items.findLast((item) => item.kind === "message");
  return (
    // In the thread's footer (its pt-3 under rows, pt-8 as the first row), Rust's rows' gaps (rows.tsx) and Thinking 12 under, so a row takes a bubble's place without a shift.
    <div className="flex flex-col gap-6 pt-2 in-data-footer:gap-8 in-data-first:pt-0 in-data-rows:pt-5">
      {shown.map((each) => {
        const dated = datedAfter(previous, each.at);
        previous = { sentAt: each.at };
        const parts = flagOf(each.op, "--parts");
        return (
          <UserBubble
            key={each.cid}
            keep={each.cid}
            text={each.op[2] ?? plainText(each.draft.parts)}
            time={each.at} older={hover || each !== shown.at(-1)}
            dated={dated}
            owner={id}
            parts={parts ? (JSON.parse(parts) as Draft).parts : each.draft.parts}
            failed={each.stuck}
            maybe={each.reached !== false}
            onRetry={each.op.length > 0 ? () => void again(run, id, each) : undefined}
            onDiscard={() => discard(run, id, each)}
            rewind={each.stuck === undefined ? undefined : { open: () => discard(run, id, each, true) }}
          />
        );
      })}
      {shown.at(-1)!.stuck === undefined && <div className="in-data-footer:-mt-5"><ThinkingLine /></div>}
    </div>
  );
}
