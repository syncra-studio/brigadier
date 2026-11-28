import type { ComponentType, ReactNode } from "react";

import { ArrowRotateCw, type IconProps, PauseCircle, ShieldExclamation, Sparkle, Stop } from "../../icons";
import { useDaemon } from "../../daemon";
import type { Item } from "../../thread/item";
import { lineWords } from "../../../../shared/words";
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

/** A worker another session ended: that session by its title, or none once it's gone. PROPOSED words [C76]. */
function StoppedBy({ item }: { item: Extract<Item, { kind: "line"; reason: "stopped" }> }) {
  const row = useDaemon().rows?.find((each) => each.id === item.from);
  return <ThreadLine icon={Stop}>{lineWords(item, row ? row.title : null).words}</ThreadLine>;
}

const ICONS: Record<Extract<Item, { kind: "line" }>["reason"], Icon> = {
  "limit-reset": ArrowRotateCw,
  model: Sparkle,
  stopped: Stop,
  paused: PauseCircle,
  interrupted: Stop,
  "review-ended": ShieldExclamation,
  stalled: Stop,
  retried: ArrowRotateCw,
};

/** Rust's `line` row in words: what changed, and the rest on its ⓘ. `action`: the app's, where the line offers one. */
export function ChangeLine({ item, action }: { item: Extract<Item, { kind: "line" }>; action?: ReactNode }) {
  if (item.reason === "stopped" && item.by === "lead") return <StoppedBy item={item} />;
  const { words, tip } = lineWords(item);
  return (
    // Under way till the new model draws a row, it shimmers as a switch's divider does (D241).
    <ThreadLine icon={ICONS[item.reason]} tip={tip} live={item.reason === "model" && item.why === "changed" ? item.live : undefined}>
      {words}
      {item.reason === "stalled" && action && <span className="ms-1.5">{action}</span>}
    </ThreadLine>
  );
}
