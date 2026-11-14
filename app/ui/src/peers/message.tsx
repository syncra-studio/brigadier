import { type FC, useContext } from "react";

import { UserBubble } from "../components/thread/message";
import { Chat } from "../icons";
import { PeerOpen } from "./rows";
import { type PeerRef, sentByCaption, UNKNOWN_SESSION } from "./words";

/*
 * What the receiver sees of another session's message [D3014], as the old app's PeerMessageBlock and QueueCard's
 * FromPeer: delivered, a bubble as the user's own, captioned with who sent it; queued, "From ‹session›" on its row.
 * It's never treated as the user [D2034].
 */

/**
 * A message another session sent this one, in the user's own bubble on the right, with over it who sent it
 * ("Sent by API work from another session"), opening the sender at its row; the time and Copy on hover. A deleted
 * sender reads "a session" and opens nothing.
 */
export const PeerMessageBlock: FC<{ from: PeerRef | null; text: string; at: number }> = ({ from, text, at }) => {
  const open = useContext(PeerOpen);
  const title = from && !from.gone ? from.title : UNKNOWN_SESSION;
  const words = (
    <>
      <Chat aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{sentByCaption(title)}</span>
    </>
  );
  const caption =
    from && !from.gone ? (
      <button
        type="button"
        data-slot="peer-caption"
        onClick={() => open(from.session, from.message)}
        className="flex max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-control text-peer-caption text-muted-foreground hover:text-foreground focus-visible:focus-ring"
      >
        {words}
      </button>
    ) : (
      <span data-slot="peer-caption" className="flex max-w-full min-w-0 items-center gap-1 text-peer-caption text-muted-foreground">
        {words}
      </span>
    );
  // The user's own bubble, the caption in its place above it, so it sits on the right as theirs do.
  return (
    <div data-slot="peer-message" role="group" aria-label={`Message from ${title}:`}>
      <UserBubble keep={`peer:${at}`} text={text} time={at} files={caption} />
    </div>
  );
};

/** A queued row another session sent: who it is from. */
export function FromPeer({ title }: { title: string | null }) {
  return <span className="min-w-0 shrink-8 truncate text-xs text-muted-foreground">From {title ?? "another session"}</span>;
}
