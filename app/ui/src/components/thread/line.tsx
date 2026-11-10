import type { ComponentType, ReactNode } from "react";

import { ArrowRotateCw, Chat, type IconProps, ShieldExclamation, Sparkle, Stop } from "../../icons";
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
      <span className="flex min-w-0 flex-wrap items-center justify-center gap-x-1.5 text-center wrap-break-word">
        {Glyph && <Glyph className="size-icon-sm shrink-0" />}
        <span className={cx("min-w-0", live && "shimmer")}>
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
      <span className="flex max-w-4/5 min-w-0 items-start gap-1.5 text-center">
        <Glyph className="mt-0.5 size-icon-sm shrink-0" />
        <span className="min-w-0 wrap-break-word">
          {children}
          {tip && <InfoTip text={tip} />}
        </span>
      </span>
    </LabeledDivider>
  );
}

/** Rust's `line` row in words: what changed, and the rest on its ⓘ. */
export function ChangeLine({ item }: { item: Extract<Item, { kind: "line" }> }) {
  switch (item.reason) {
    case "limit-reset":
      return <ThreadLine icon={ArrowRotateCw}>Usage limit reset · {hhmm(item.at)}</ThreadLine>;
    case "model":
      return item.why === "changed" ? (
        <ThreadLine icon={Sparkle} tip={`${item.from ? `From ${item.from}. ` : ""}Answers may read differently from here on.`}>
          Switched model to {item.to}
        </ThreadLine>
      ) : (
        <ThreadLine icon={Sparkle} tip={item.from ? `The agent sent this request on from ${item.from}.` : "The agent sent this request on to another model."}>
          This request went to {item.to}
        </ThreadLine>
      );
    case "stopped":
      return <ThreadLine icon={Stop}>{item.ms === null ? "You stopped" : `You stopped after ${duration(item.ms)}`}</ThreadLine>;
    case "review-ended":
      return (
        <ThreadLine icon={ShieldExclamation} tip="It turned down too many actions in a row. Say more about the task, or change the permission level, to go on.">
          The automatic reviewer ended this turn
        </ThreadLine>
      );
    case "continued":
      return (
        <ThreadLine icon={Chat}>
          Continued from{" "}
          <a href={`#thread/${encodeURIComponent(item.session)}`} className="text-link hover:underline">
            {item.title ?? "another conversation"}
          </a>
        </ThreadLine>
      );
  }
}
