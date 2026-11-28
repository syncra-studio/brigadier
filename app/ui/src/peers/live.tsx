import { type ReactNode, useSyncExternalStore } from "react";

import { type Row, useDaemon, useThread } from "../daemon";
import { run } from "../onboarding/api";
import type { ComposerRow } from "../session/composer";
import { inThread } from "../session/queued";
import type { Item } from "../thread/item";
import type { Source } from "../thread/thread";
import { PeerMessageBlock } from "./message";
import { HopStopRow, PeerOpen, PeerSentRow, SessionSentRow } from "./rows";
import { type PeerRef, peerExchange, peerOf, RATE_STOPPED, UNKNOWN_SESSION, UNSURE } from "./words";

/*
 * 4.2's peer rows on Rust's thread items [D2034, D3014]: the sender's `peer` row, folded by Rust from its notes, and
 * the receiver's bubble (a message with origin `peer`). Names come from the rows; a session the app no longer has
 * reads "a session".
 */

type PeerItem = Extract<Item, { kind: "peer" }>;

const open = (session: string) => {
  location.hash = `#thread/${encodeURIComponent(session)}`;
};

function usePeer(session: string | null): PeerRef | null {
  const rows: Row[] = useDaemon().rows ?? [];
  return session === null ? null : peerOf(session, rows);
}

const Opens = ({ children }: { children: ReactNode }) => <PeerOpen.Provider value={open}>{children}</PeerOpen.Provider>;

/** A message this session's agent sent another: "Messaged Docs: …", its wait, or the stop row and Send anyway. */
export function PeerRow({ item }: { item: PeerItem }) {
  const session = useThread()?.id ?? "";
  const to = usePeer(item.to);
  if (item.state === "stopped") {
    const words = item.why === "rate" ? RATE_STOPPED : undefined;
    return <HopStopRow words={words} onSend={() => void run(["peers", session, "send", item.mid])} />;
  }
  if (!item.wait || item.state === "refused") {
    const state = item.state === "dropped" ? "refused" : item.state;
    return (
      <Opens>
        <SessionSentRow keep={item.id} to={to} state={state} text={item.text} refused={item.why ?? (state === "uncertain" ? UNSURE : undefined)} />
      </Opens>
    );
  }
  const ref = to ?? { session: item.to, title: UNKNOWN_SESSION, gone: true };
  return (
    <Opens>
      <PeerSentRow
        keep={item.id}
        text={item.text}
        exchange={peerExchange(item, ref)}
      />
    </Opens>
  );
}

/** Another session's message in this thread: the user's bubble, captioned with who sent it; never the user [D2034]. */
export function PeerBubble({ from, text, at, waiting }: { from: string; text: string; at: number; waiting?: boolean }) {
  const session = useThread()?.id;
  const worker = useDaemon().rows?.some((row) => row.id === from && row.worker?.parent === session) ?? false;
  return (
    <Opens>
      <PeerMessageBlock from={usePeer(from)} text={text} at={at} worker={worker} waiting={waiting} />
    </Opens>
  );
}

/** Other sessions' messages `id`'s agent hasn't got yet, less those its thread or queue shows. */
export function useArriving(id: string, source: Source) {
  const row: ComposerRow | undefined = useDaemon().rows?.find((r) => r.id === id);
  const shown = inThread(useSyncExternalStore(source.subscribe, source.get));
  return (row?.arriving ?? []).filter((each) => !shown.has(each.id) && !row?.queue?.items.some((item) => item.id === each.id));
}

/** Those messages, waiting under the thread's last row till each one's own takes its place. */
export function ArrivingBubbles({ list }: { list: ReturnType<typeof useArriving> }) {
  if (list.length === 0) return null;
  return (
    // Rust's rows' gaps, as SentBubbles'.
    <div className="flex flex-col gap-6 pt-2 in-data-footer:gap-8 in-data-first:pt-0 in-data-rows:pt-5">
      {list.map((each) => (
        <PeerBubble key={each.id} from={each.from} text={each.text} at={each.at} waiting />
      ))}
    </div>
  );
}
