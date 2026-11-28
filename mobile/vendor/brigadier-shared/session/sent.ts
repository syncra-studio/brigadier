import type { Chip } from "../chips";
import type { Draft } from "../draft";
import type { Drafts } from "./draft";
import { failure, type Runner } from "./run";
import { type Going, UNCONFIRMED, type Uncertain } from "./uncertain";

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

/**
 * One Mac's sends [D58]. `connection`: the connection now, the one a message goes on (only a later one hands it to Rust
 * again); `sendFailed`: a send refused, so the thread gives up the space it kept for it.
 */
export function sendState(uncertain: Uncertain, drafts: Drafts, { connection, sendFailed }: { connection: () => unknown; sendFailed: (cid: string) => void }) {
  const { forget, keepGoing, markGoing, tellDrops, keptChipsBack } = uncertain;
  const { resyncDraft, takeBack } = drafts;
  // The connection each message went on, or was last handed over on: only a later one hands it to Rust again.
  const asked = new Map<string, unknown>();

  /** Message `entry` kept here as it goes on this connection, before the field empties. */
  function keep(id: string, entry: Going): Going {
    asked.set(entry.cid, connection());
    return keepGoing(id, entry);
  }

  /** Message `entry` goes: kept here first, so a reload loses nothing, then run with the draft it came from and the field's revision then. */
  function go(run: Runner, id: string, entry: Going, rev: number | null): Promise<void> {
    keep(id, { ...entry, rev });
    return run([...entry.op, ...(entry.peer ? [] : draftArgs(entry.draft, rev))]).then(
      (reply) => answered(run, id, entry, reply),
      (cause) => markGoing(id, entry.cid, { stuck: String(cause) }),
    );
  }

  /** What Rust's reply says of message `entry`: given back into the draft, gone where it went, or held by Rust's book unsettled; no reply, it stays kept here. */
  function answered(run: Runner, id: string, entry: Going, reply: Record<string, any>): void {
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
    return run(["draft", id, "adopt", entry.cid, "--kind", entry.kind, "--op", JSON.stringify(entry.op), "--draft", JSON.stringify(entry.draft), ...(typeof entry.rev === "number" ? ["--draft-rev", String(entry.rev)] : [])]).then((reply) => {
      // Given back, its chips wait again: the draft's read can't release them once it's forgotten.
      if (reply.given_back) keptChipsBack(id, entry);
      if (reply.ok && !reply.kept) forget(id, entry.cid);
      if (reply.given_back) resyncDraft(run, id);
      if (reply.kept) markGoing(id, entry.cid, { booked: true, reached: reply.reached === true, stuck: entry.stuck || UNCONFIRMED });
      return reply;
    });
  }

  /** Try again or Add again: Rust runs the message's own command again under its id (`retry`), once its book has it. */
  async function again(run: Runner, id: string, entry: Going): Promise<void> {
    markGoing(id, entry.cid, { stuck: undefined });
    if (entry.peer) return go(run, id, { ...entry, stuck: undefined }, null);
    const adopted = entry.booked ? { kept: true } : await adopt(run, id, entry);
    if (adopted.kept) return answered(run, id, { ...entry, booked: true }, await run(["draft", id, "retry", entry.cid]));
    if (!adopted.ok) markGoing(id, entry.cid, { stuck: failure(adopted) });
  }

  /** Discard, Delete or Edit: Rust takes the message out wherever it waits (`drop`), now or once it answers again; Edit brings its words back at once, as a new message. */
  function discard(run: Runner, id: string, entry: Going, edit = false): void {
    markGoing(id, entry.cid, { removing: true });
    if (edit) takeBack(run, id, { cid: crypto.randomUUID(), ...entry.draft });
    void tellDrops(run, id);
  }

  /** A message sent from outside the composer, with its pending bubble and command-id recovery: the retry after a rewind (`retryOf`).
   * Not the field's words, so its revision is none: going or given back, it never clears what the field holds. */
  function sendMessage(run: Runner, id: string, text: string, retryOf?: string, draft?: Draft | null, origin = "user"): Promise<void> {
    const cid = crypto.randomUUID();
    const op = sendOp(id, text, cid, { parts: draft ? JSON.stringify(draft) : undefined, retryOf });
    // Another session's brief or a note is never the user's words to give back [D2034]: kept here only, its refusal on its bubble.
    const peer = origin !== "user" || undefined;
    return go(run, id, { cid, kind: "send", op, draft: draft ?? { parts: [text], attachmentIds: [] }, at: Date.now(), peer }, null);
  }
  return { asked, keep, go, answered, adopt, again, discard, sendMessage };
}

export const sends = (list: readonly Going[]) => list.filter((each) => each.kind === "send" && !each.removing);
