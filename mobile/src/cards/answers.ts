// Answers on their way, as the desktop's session/decisions.tsx keeps them: the card goes at once; a refusal brings it
// back with its words; one the Mac took stays hidden until Rust no longer lists it. Nothing is ever resent by itself.
import { type PendingApproval, type PendingQuestion, refusalWords } from "../../../app/shared/cards";
import type { Frame } from "../../../app/shared/client";
import { store } from "../../../app/shared/store";
import { ask } from "../link";

export type Card = PendingApproval | PendingQuestion;
export type Answer = { card: Card; error?: string };
/** By session, then request id. */
export const answering = store<ReadonlyMap<string, ReadonlyMap<string, Answer>>>(new Map());

function put(session: string, request: string, answer: Answer | undefined) {
  const all = new Map(answering.get());
  const mine = new Map(all.get(session));
  answer ? mine.set(request, answer) : mine.delete(request);
  all.set(session, mine);
  answering.set(all);
}

/** Rust's refusal in words, and the phone's own two. */
function refusal(reply: Frame): string {
  // The phone's allowlist refuses an answer to a request that no longer waits before the answer is read.
  if (reply.error === "Not from the phone") return "Nothing is waiting for this answer";
  // The stream ended before the Mac's reply: it may have been taken. Check before answering again.
  if (reply.error === "closed") return "Your answer may not have reached your Mac";
  return refusalWords(reply);
}

/** The card goes while its answer is on its way. */
export const begin = (session: string, card: Card) => put(session, card.id, { card });

/** The Mac's reply to an answer: taken, it stays hidden; refused, the card comes back with why. */
export function settle(session: string, card: Card, reply: Frame) {
  if (reply.ok) return put(session, card.id, { card });
  const error = refusal(reply);
  // A held worker's card drawn again: the refusal shows on the new card.
  if (typeof reply.request === "string" && reply.request !== card.id) {
    put(session, card.id, undefined);
    return put(session, reply.request, { card: { ...card, id: reply.request }, error });
  }
  put(session, card.id, { card, error });
}

/** A one-time answer, straight through (`brigadier answer`). */
export async function send(session: string, card: Card, args: string[]) {
  begin(session, card);
  settle(session, card, await ask({ op: "run", args }).catch(() => ({ ok: false, error: "closed" })));
}

/** Drops what is no longer needed: a taken answer once Rust stops listing its card, or a refused one dismissed. */
export const forget = (session: string, request: string) => put(session, request, undefined);
