import type { ComponentType, ReactNode } from "react";

import { ArrowRotateCw, type IconProps, PauseCircle, ShieldExclamation, Sparkle, Stop } from "../../icons";
import { useDaemon } from "../../daemon";
import type { Item } from "../../thread/item";
import { duration, hhmm } from "../../thread/words";
import { cx } from "../cx";
import { LabeledDivider } from "../labeled-divider";
import { InfoTip } from "./tip";

type Icon = ComponentType<IconProps>;

/**
 * A line across the thread where something changed (D487): an icon, the words, an ⓘ whose tip says the rest, and
 * what follows them (a link), between two hairlines. `live` shimmers it while it's under way.
 */
export function ThreadLine({ icon: Glyph, tip, live, children }: { icon?: Icon; tip?: string; live?: boolean; children: ReactNode }) {
  return (
    <LabeledDivider role="status">
      <span className="min-w-0 text-center wrap-break-word">
        <span className={cx("min-w-0", live && "shimmer")}>
          {Glyph && <span className="me-2 w-icon-sm cap-box"><Glyph className="size-icon-sm" /></span>}
          {children}
          {tip && <InfoTip text={tip} />}
        </span>
      </span>
    </LabeledDivider>
  );
}

/** A status that may take two lines, between the same hairlines: an icon held to the first line, then the sentence. */
export function InlineStatus({ icon: Glyph, tip, children }: { icon: Icon; tip?: string; children: ReactNode }) {
  return (
    <LabeledDivider role="status">
      <span className="flex max-w-4/5 min-w-0 items-start gap-2 text-center">
        <Glyph className="mt-0.5 size-icon-sm shrink-0" />
        <span className="min-w-0 wrap-break-word">
          {children}
          {tip && <InfoTip text={tip} />}
        </span>
      </span>
    </LabeledDivider>
  );
}

/** Rust's `line` row in words: what changed, and the rest on its ⓘ. `action`: the app's, where the line offers one. */
/** A worker another session ended: that session by its title, or none once it's gone. PROPOSED words [C76]. */
function StoppedBy({ from, ms }: { from: string | null; ms: number | null }) {
  const row = useDaemon().rows?.find((each) => each.id === from);
  const who = row ? `${row.title || "New session"} stopped it` : "Stopped";
  return <ThreadLine icon={Stop}>{ms === null ? who : `${who} after ${duration(ms)}`}</ThreadLine>;
}

export function ChangeLine({ item, action }: { item: Extract<Item, { kind: "line" }>; action?: ReactNode }) {
  switch (item.reason) {
    case "limit-reset":
      // Brigadier's own carry-on at the reset says so (proposed) [C34, C54].
      return <ThreadLine icon={ArrowRotateCw}>Usage limit reset · {item.carried ? `carried on at ${hhmm(item.carried)}` : hhmm(item.at)}</ThreadLine>;
    case "model":
      return item.why === "changed" ? (
        // Under way till the new model draws a row, it shimmers as a switch's divider does (D241).
        <ThreadLine icon={Sparkle} live={item.live} tip={`${item.from ? `From ${item.from}. ` : ""}Answers may read differently from here on.`}>
          {item.live ? `Switching model to ${item.to}…` : `Switched model to ${item.to}`}
        </ThreadLine>
      ) : (
        <ThreadLine icon={Sparkle} tip={item.from ? `The agent sent this request on from ${item.from}.` : "The agent sent this request on to another model."}>
          This request went to {item.to}
        </ThreadLine>
      );
    case "stopped":
      if (item.by === "lead") return <StoppedBy from={item.from ?? null} ms={item.ms} />;
      return <ThreadLine icon={Stop}>{item.ms === null ? "You stopped" : `You stopped after ${duration(item.ms)}`}</ThreadLine>;
    // A worker's Pause, in its own thread: Resume carries it on [D90].
    case "paused":
      return <ThreadLine icon={PauseCircle}>{item.ms === null ? "You paused" : `You paused after ${duration(item.ms)}`}</ThreadLine>;
    // The run's host or agent was gone before the turn ended; Resume carries it on (D92).
    case "interrupted":
      return <ThreadLine icon={Stop}>Interrupted · the run stopped before it finished</ThreadLine>;
    case "review-ended":
      return (
        <ThreadLine icon={ShieldExclamation} tip="It turned down too many actions in a row. Say more about the task, or change the permission level, to go on.">
          The automatic reviewer ended this turn
        </ThreadLine>
      );
    case "stalled":
      return (
        <ThreadLine icon={Stop}>
          Stopped: this task keeps filling its context without making progress
          {action && <span className="ms-1.5">{action}</span>}
        </ThreadLine>
      );
    case "retried":
      return <ThreadLine icon={ArrowRotateCw}>Sent again · the previous attempt was replaced</ThreadLine>;
  }
}
