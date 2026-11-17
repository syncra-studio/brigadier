import { Button } from "../components/button";
import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { Check, Reload } from "../icons";
import { useSecond } from "../thread/words";
import { PullRequestClosed, PullRequestDraft, PullRequestMerged, PullRequestOpen, Sparkles } from "./icons";
import { ago, STATE_WORDS } from "./pr-words";
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

/** Who, as their initial in a circle. */
export const Avatar = ({ login, size = "size-5" }: { login: string; size?: string }) => (
  <span title={login} className={cx("flex shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-medium text-foreground uppercase", size)}>
    {login[0]}
  </span>
);

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
 * When the host was last read, and Check again: it reads it now, the icon turning until it answers [D208]. It ticks on
 * its own, so the page under it isn't drawn again each second.
 */
export function CheckAgain({ at, busy, offline, onClick }: { at: number | null; busy: boolean; offline: boolean; onClick: () => void }) {
  const now = useSecond(at !== null);
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      {offline ? "Reconnecting…" : at !== null ? `Checked ${ago(at, now)}` : busy ? "Checking…" : "Not checked yet"}
      <TooltipIconButton tooltip="Check again" size="icon-sm" disabled={offline || busy} onClick={onClick}>
        <Reload className={cx(busy && "animate-spin motion-reduce:animate-none")} />
      </TooltipIconButton>
    </span>
  );
}
