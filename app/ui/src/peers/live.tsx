import type { ReactNode } from "react";

import { type Row, useDaemon, useThread } from "../daemon";
import { run } from "../onboarding/api";
import type { Item } from "../thread/item";
import { PeerMessageBlock } from "./message";
import { HopStopRow, PeerOpen, PeerSentRow, SessionSentRow } from "./rows";
import { type PeerRef, type PeerState, UNKNOWN_SESSION } from "./words";

/*
 * 4.2's peer rows on Rust's thread items [D2034, D3014]: the sender's `peer` row, folded by Rust from its notes, and
 * the receiver's bubble (a message with origin `peer`). Names come from the rows; a session the app no longer has
 * reads "a session".
 */

type PeerItem = Extract<Item, { kind: "peer" }>;

/** Proposed: why a message reads uncertain. */
const UNSURE = "Its session didn’t confirm it, so it wasn’t sent again.";

const open = (session: string) => {
  location.hash = `#thread/${encodeURIComponent(session)}`;
};

function usePeer(session: string | null): PeerRef | null {
  const rows: Row[] = useDaemon().rows ?? [];
  if (session === null) return null;
  const row = rows.find((r) => r.id === session);
  return row ? { session, title: row.title } : { session, title: UNKNOWN_SESSION, gone: true };
}

const Opens = ({ children }: { children: ReactNode }) => <PeerOpen.Provider value={open}>{children}</PeerOpen.Provider>;

/** A message this session's agent sent another: "Messaged Docs: …", its wait, or the stop row and Send anyway. */
export function PeerRow({ item }: { item: PeerItem }) {
  const session = useThread()?.id ?? "";
  const to = usePeer(item.to);
  if (item.state === "stopped") {
    // Proposed: the rate limit's words; the hop limit's are 4.2's.
    const words = item.why === "rate" ? "Stopped at 20 messages a minute" : undefined;
    return <HopStopRow words={words} onSend={() => void run(["peers", session, "send", item.mid])} />;
  }
  if (!item.wait || item.state === "refused") {
    const state = item.state === "dropped" ? "refused" : item.state;
    return (
      <Opens>
        <SessionSentRow to={to} state={state} text={item.text} refused={item.why ?? (state === "uncertain" ? UNSURE : undefined)} />
      </Opens>
    );
  }
  const send: PeerState =
    item.state === "sending"
      ? { type: "pending" }
      : item.state === "dropped" || item.state === "uncertain"
        ? { type: "refused", reason: item.why ?? UNSURE }
        : { type: item.waited === "replied" ? "replied" : "delivered" };
  const ref = to ?? { session: item.to, title: UNKNOWN_SESSION, gone: true };
  return (
    <Opens>
      <PeerSentRow
        exchange={{
          sends: [{ ...ref, state: send }],
          waits: item.waited === undefined ? (item.state === "sending" ? [] : ["inProgress"]) : ["completed"],
          received: item.waited === "replied" ? [ref] : [],
          waitingOn: item.waited === undefined ? [ref] : [],
        }}
      />
    </Opens>
  );
}

/** Another session's message in this thread: the user's bubble, captioned with who sent it; never the user [D2034]. */
export function PeerBubble({ from, text, at }: { from: string; text: string; at: number }) {
  return (
    <Opens>
      <PeerMessageBlock from={usePeer(from)} text={text} at={at} />
    </Opens>
  );
}
