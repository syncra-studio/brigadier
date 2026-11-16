/*
 * How messages between sessions read in the thread, as the old app's peerWords [D3014]: the sender's row of what it
 * sent and how it waited, the receiver's caption. Words only; Rust holds the records.
 */

/** A session a row names: its id and title, the message the row opens it at, and `gone` once deleted. */
export type PeerRef = { session: string; title: string; message?: string; gone?: boolean };

/** A row's words: plain text, and the sessions it names, each a link. */
export type WordPart = string | PeerRef;

/** How a message stands; wave 4 never holds one for the user's OK (approving `brigadier` is always safe, D2026). */
export type PeerState = { type: "pending" | "delivered" | "seen" | "replied" | "declined" } | { type: "refused" | "dropped"; reason: string };

export type PeerSend = PeerRef & { state: PeerState };

export type Status = "inProgress" | "completed" | "failed";

/** What one row of messages and waits stands at: what it sent, its waits, whose replies they took, whom it still waits for. */
export type Exchange = {
  sends: readonly PeerSend[];
  waits: readonly Status[];
  received: readonly PeerRef[];
  waitingOn: readonly PeerRef[];
  /** Just sent, nothing after it yet: it still reads as sending, so the wait that usually follows takes it over. */
  going?: boolean;
};

/** A session the app no longer has (deleted): named plainly. */
export const UNKNOWN_SESSION = "a session";

/** "A", "A and B", "A, B and C": each session once. */
function named(refs: readonly PeerRef[]): WordPart[] {
  const once = refs.filter((ref, index) => refs.findIndex((other) => other.session === ref.session) === index);
  return once.flatMap((ref, index): WordPart[] => (index === 0 ? [ref] : [index === once.length - 1 ? " and " : ", ", ref]));
}

const messages = (sends: readonly unknown[]) => (sends.length === 1 ? "message" : "messages");

/** Whether a message went (or goes now) to its receiver. */
const went = (state: PeerState) => state.type === "pending" || state.type === "delivered" || state.type === "seen" || state.type === "replied";

/** The words of a row of messages and waits, and how it stands: "Sent message to Docs, waited for its reply". */
export function exchangeWords({ sends, waits, received, waitingOn, going = false }: Exchange): { parts: WordPart[]; status: Status; waiting: boolean } {
  const sending = sends.filter((send) => send.state.type === "pending");
  if (sending.length > 0) return { parts: [`Sending ${messages(sending)} to `, ...named(sending)], status: "inProgress", waiting: false };
  const sent = sends.filter((send) => went(send.state));
  if (going && waits.length === 0 && sent.length > 0 && sent.length === sends.length) {
    return { parts: [`Sending ${messages(sent)} to `, ...named(sent)], status: "inProgress", waiting: false };
  }
  if (waits.includes("inProgress")) {
    const on = waitingOn.length > 0 ? waitingOn : sent;
    return { parts: on.length > 0 ? ["Waiting for ", ...named(on), " to reply"] : ["Waiting for replies"], status: "inProgress", waiting: true };
  }
  const clauses: WordPart[][] = [];
  if (sent.length > 0) clauses.push([`Sent ${messages(sent)} to `, ...named(sent)]);
  const declined = sends.filter((send) => send.state.type === "declined");
  if (declined.length > 0) clauses.push([`Didn’t send ${messages(declined)} to `, ...named(declined)]);
  const failed = sends.filter((send) => send.state.type === "refused" || send.state.type === "dropped");
  if (failed.length > 0) clauses.push([`Couldn’t send ${messages(failed)} to `, ...named(failed)]);
  if (waits.length > 0) clauses.push(waited(sent, received, waits.at(-1) === "failed", sends.length === 0));
  return { parts: clauses.flatMap((clause, index) => (index === 0 ? clause : [", ", ...lower(clause)])), status: "completed", waiting: false };
}

/** The clause of a row's waits once they are over. */
function waited(sent: readonly PeerRef[], received: readonly PeerRef[], failed: boolean, alone: boolean): WordPart[] {
  const sessions = (refs: readonly PeerRef[]) => new Set(refs.map((ref) => ref.session));
  if (received.length === 0) return failed ? ["Couldn’t wait for a reply"] : ["Waited; no reply yet"];
  const all = sessions(received);
  if (!alone && [...sessions(sent)].every((session) => all.has(session))) return [all.size === 1 ? "Waited for its reply" : "Waited for their replies"];
  // A wait on its own (`brigadier wait` on another session) took the reply.
  if (alone) return all.size === 1 ? ["Received a reply from ", ...named(received)] : ["Received replies from ", ...named(received)];
  return all.size === 1 ? ["Waited for a reply from ", ...named(received)] : ["Waited for replies from ", ...named(received)];
}

/** A clause after the first: its first word in lower case. */
function lower(clause: WordPart[]): WordPart[] {
  const [first, ...rest] = clause;
  return typeof first === "string" ? [first.charAt(0).toLowerCase() + first.slice(1), ...rest] : clause;
}

/** How a message the thread's own `brigadier send` gave another session stands. */
export type SessionSendState = "sending" | "sent" | "declined" | "refused" | "uncertain";

/** The words before the session a `brigadier send` row names. */
export function sessionSendWords(state: SessionSendState): string {
  switch (state) {
    case "sending":
      return "Messaging ";
    case "sent":
      return "Messaged ";
    case "declined":
      return "Didn’t send message to ";
    case "refused":
      return "Couldn’t send message to ";
    // Proposed: logged in its session, never proven taken, and never sent again by itself [D54, D82].
    case "uncertain":
      return "Couldn’t confirm message to ";
  }
}

/** The caption over a message another session sent: "Sent by API work from another session"; one of this session's
 * workers, "Sent by API work, a worker of this session" [D394]. */
export const sentByCaption = (title: string, worker = false) => `Sent by ${title}${worker ? ", a worker of this session" : " from another session"}`;
