import { useState } from "react";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { Check, Reload } from "../icons";
import { PullRequestClosed, PullRequestDraft, PullRequestMerged, PullRequestOpen, Sparkles } from "./icons";
import { STATE_WORDS } from "./pr-words";
import { type PrSend, type PrState, sendKey } from "./pull-requests";

/** What every PR part shares: the time to measure from, what's already above the composer, and how to add more. */
export type Sends = {
  now: number;
  offline: boolean;
  /** Sends already waiting as chips, by `sendKey`: their buttons read Added. */
  added: ReadonlySet<string>;
  onSend: (send: PrSend) => void;
  onOpen: (url: "pr" | { check: string } | { comment: string } | { url: string }) => void;
};

const STATE_ICONS = {
  open: <PullRequestOpen className="text-success" />,
  draft: <PullRequestDraft className="text-muted-foreground" />,
  merged: <PullRequestMerged className="text-pr-purple" />,
  closed: <PullRequestClosed className="text-destructive" />,
};

/** A PR's state as its icon, coloured, its word the tooltip's [D609]. */
export const StateIcon = ({ state, className }: { state: PrState; className?: string }) => (
  <span role="img" aria-label={STATE_WORDS[state]} title={STATE_WORDS[state]} className={cx("flex svg:size-icon-sm", className)}>
    {STATE_ICONS[state]}
  </span>
);

// The logins whose picture Rust has kept: shown at once from then on.
const pictured = new Set<string>();

/**
 * Who, as their picture once Rust keeps it, else their initial in the same circle [D614, D615]. `at`: the read that
 * named them; a new one looks again for a picture not kept yet, which takes the initial's place with no loader.
 */
export function Avatar({ login: who, at = 0, size = "size-5" }: { login: string | null; at?: number | null; size?: string }) {
  const [, shown] = useState(false);
  // A deleted account has none: GitHub's ghost.
  const login = who || "ghost";
  const src = `/avatar/${encodeURIComponent(login)}`;
  return (
    <span title={login} className={cx("flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-2xs font-medium text-foreground uppercase", size)}>
      {pictured.has(login) ? (
        <img alt="" src={src} className="size-full object-cover" />
      ) : (
        <>
          {login[0]}
          <img
            key={at}
            hidden
            alt=""
            src={`${src}?at=${at}`}
            onLoad={() => {
              pictured.add(login);
              shown(true);
            }}
          />
        </>
      )}
    </span>
  );
}

/** A Send to agent button: it leaves a chip above the composer and sends nothing [D1019, D1027]; once it has, it reads Added. */
export function SendButton({ send, label = "Send to agent", sends }: { send: PrSend; label?: string; sends: Sends }) {
  const added = sends.added.has(sendKey(send));
  return (
    <Button variant="soft" size="xs" disabled={added || sends.offline} onClick={() => sends.onSend(send)}>
      {added ? <Check /> : <Sparkles />}
      {added ? "Added" : label}
    </Button>
  );
}

/**
 * Check again: it reads the host now, the icon turning until it answers [D208]. No age beside it, so nothing shifts
 * as seconds pass [D656].
 */
export function CheckAgain({ busy, offline, onClick }: { busy: boolean; offline: boolean; onClick: () => void }) {
  return (
    <TooltipIconButton tooltip={offline ? "Reconnecting…" : "Check again"} size="icon-sm" disabled={offline || busy} onClick={onClick}>
      <Reload className={cx(busy && "animate-spin motion-reduce:animate-none")} />
    </TooltipIconButton>
  );
}
