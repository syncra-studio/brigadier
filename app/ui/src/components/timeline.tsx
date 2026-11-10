import type { ReactNode } from "react";

import { cx } from "./cx";

/** One event: when it happened ("14:32"), what, a line of detail, and anything more under it. */
export type TimelineEvent = {
  id: string;
  /** "now" is the event still going on; it reads stronger. */
  when: "past" | "now";
  time: string;
  title: ReactNode;
  detail?: ReactNode;
  more?: ReactNode;
  /** Marked red. */
  failed?: boolean;
};

/** Events in order, joined by a line, each with its time: the old app's timeline (its past, now and failed events). */
export function Timeline({ events, className }: { events: readonly TimelineEvent[]; className?: string }) {
  return (
    <ol data-slot="timeline" className={cx("flex w-full min-w-0 flex-col", className)}>
      {events.map((event, index) => {
        const last = index === events.length - 1;
        return (
          <li key={event.id} aria-current={event.when === "now" ? "step" : undefined} className="flex min-w-0 gap-2">
            <span className="w-11 shrink-0 pt-0.5 text-end font-mono text-2xs tracking-tight whitespace-nowrap text-muted-foreground tabular-nums">
              {event.time}
            </span>
            <span aria-hidden className="flex w-3 shrink-0 flex-col items-center">
              <span
                className={cx(
                  "mt-1.5 size-2 shrink-0 rounded-full",
                  event.failed ? "bg-destructive" : event.when === "now" ? "bg-foreground ring-4 ring-input" : "bg-timeline-past",
                )}
              />
              {!last && <span className="w-px flex-1 bg-scrim" />}
            </span>
            <div className={cx("flex min-w-0 flex-1 flex-col gap-0.5", !last && "pb-3")}>
              <span
                className={cx(
                  "text-sm wrap-anywhere",
                  event.failed ? "text-destructive" : "text-timeline-title",
                  event.when === "now" && "font-medium",
                )}
              >
                {event.title}
              </span>
              {event.detail && <span className="text-xs leading-relaxed wrap-anywhere text-muted-foreground">{event.detail}</span>}
              {event.more}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
