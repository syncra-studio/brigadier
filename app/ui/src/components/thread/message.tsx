import type { ReactNode } from "react";

import { ChevronRightAlt, Trash } from "../../icons";
import { useKept } from "../../thread/kept";
import { CopyButton } from "../copy-button";
import { cx } from "../cx";
import { ErrorLine } from "../error-line";
import { TooltipIconButton } from "../icon-button";

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const monthDay = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const fullDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

/** When a message was sent: "3:09 PM", "Yesterday 3:09 PM", "Mon 3:09 PM", "Mon, Mar 3 at 3:09 PM", "Mar 3, 2025 at 3:09 PM". */
export function sentAt(ms: number, now = Date.now()): string {
  const at = new Date(ms);
  const day = new Date(now);
  // Midnight `back` calendar days ago: a day across a clock change isn't 24 hours.
  const midnight = (back: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate() - back).getTime();
  const clock = time.format(at);
  if (ms >= midnight(0)) return clock;
  if (ms >= midnight(1)) return `Yesterday ${clock}`;
  if (ms >= midnight(6)) return `${weekday.format(at)} ${clock}`;
  if (at.getFullYear() === new Date(now).getFullYear()) return `${monthDay.format(at)} at ${clock}`;
  return `${fullDate.format(at)} at ${clock}`;
}

// shortcut: guesses a long message from its text (no measuring, so rows stay cheap); a message of many
// short wrapped lines may show "Show more" with little to show. Measure once rows may measure.
const LONG_LINES = 20;
const LONG_CHARS = 1200;

/**
 * The user's message, on the right. Hovered or focused, its time and a copy button show under it; past 20
 * lines it folds with "Show more". A message on its way shows "Sending…"; one whose delivery can't be
 * proven yet is `unconfirmed`. One that failed keeps its actions in view, with Discard, and says why on an
 * ErrorLine with Try again. `dimmed` greys it (a message the turn hasn't reached).
 */
export function UserBubble({
  keep,
  text,
  time,
  sending,
  failed,
  onRetry,
  onDiscard,
  unconfirmed = false,
  dimmed = false,
}: {
  /** Keeps its fold while it scrolls out of view. */
  keep: string;
  text: string;
  /** When it was sent (ms). */
  time?: number;
  sending?: boolean;
  /** Why it wasn't sent. */
  failed?: string;
  onRetry?: () => void;
  onDiscard?: () => void;
  /** Sent, but its delivery can't be proven while the link is down. */
  unconfirmed?: boolean;
  dimmed?: boolean;
}) {
  const [more, setMore] = useKept(`${keep}:more`);
  const long = text.length > LONG_CHARS || text.split("\n", LONG_LINES + 1).length > LONG_LINES;
  return (
    <div className="group/user flex flex-col items-end gap-y-1">
      <div className="flex max-w-7/10 min-w-0 flex-col items-end gap-y-1">
        <div className={cx("flex max-w-full min-w-0 flex-col rounded-bubble bg-muted px-4 py-2.5 text-foreground", (dimmed || sending || unconfirmed) && "opacity-row-disabled")}>
          <p className={cx("whitespace-pre-wrap wrap-anywhere", long && !more && "max-h-user-message overflow-y-clip")}>{text}</p>
          {long && (
            <button
              type="button"
              aria-expanded={more}
              onClick={() => setMore(!more)}
              className="flex cursor-pointer items-center gap-0.5 self-start rounded-control pt-1 text-xs text-muted-foreground hover:text-foreground focus-visible:focus-ring"
            >
              {more ? "Show less" : "Show more"}
              <ChevronRightAlt className={cx("size-icon-xs transition-transform", more ? "-rotate-90" : "rotate-90")} />
            </button>
          )}
        </div>
        {sending ? (
          <p className="text-xs text-muted-foreground">Sending…</p>
        ) : unconfirmed ? (
          <p role="status" className="text-xs text-muted-foreground">
            Not confirmed · it's checked once the link is back
          </p>
        ) : (
          // Hover-only, its space kept so nothing shifts; a failed message's stay in view.
          <div
            className={cx(
              "-mt-1 flex items-center gap-1 text-muted-foreground",
              !failed && "opacity-0 transition-opacity group-focus-within/user:opacity-100 group-hover/user:opacity-100",
            )}
          >
            {time !== undefined && <span className="pe-1 text-xs tabular-nums">{sentAt(time)}</span>}
            <CopyButton text={text} tooltip="Copy message" copiedDuration={1500} />
            {failed && onDiscard && (
              <TooltipIconButton tooltip="Discard message" onClick={onDiscard}>
                <Trash />
              </TooltipIconButton>
            )}
          </div>
        )}
        {!sending && !unconfirmed && (
          <ErrorLine
            size="sm"
            error={failed && `Not sent · ${failed}`}
            className="items-end text-end"
            actions={
              onRetry ? (
                <button type="button" onClick={onRetry} className="cursor-pointer rounded-control text-link hover:text-link-hover focus-visible:focus-ring">
                  Try again
                </button>
              ) : null
            }
          />
        )}
      </div>
    </div>
  );
}

/** A line the app sent on the user's behalf: centred and muted. */
export function SystemLine({ text }: { text: string }) {
  return (
    <div className="flex justify-center text-center text-xs text-muted-foreground">
      <p className="max-w-4/5 whitespace-pre-wrap">{text}</p>
    </div>
  );
}

/**
 * The agent's answer: `children` is the rendered reply. Once it stops streaming, its actions show under
 * it, always (not only on hover): copy, then the time.
 */
export function AssistantMessage({ text, streaming, time, children }: { text: string; streaming: boolean; time?: number; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="leading-relaxed wrap-break-word text-foreground">{children}</div>
      {!streaming && (
        <div className="-ms-1 flex items-center gap-0.5 text-faint-foreground">
          <CopyButton text={text} tooltip="Copy response" size="icon-answer" />
          {time !== undefined && <span className="ps-1 text-xs tabular-nums">{sentAt(time)}</span>}
        </div>
      )}
    </div>
  );
}

/** The live "Thinking" line while the agent thinks: the thought's newest heading if there is one. */
export function ThinkingLine({ heading }: { heading?: string | null }) {
  const words = heading || "Thinking";
  return (
    <p key={words} className="w-fit max-w-full truncate text-sm leading-5.25 shimmer">
      {words}
    </p>
  );
}
