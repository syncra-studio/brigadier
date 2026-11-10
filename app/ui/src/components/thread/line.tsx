import type { ComponentType, ReactNode } from "react";

import type { IconProps } from "../../icons";
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
export function InlineStatus({ icon: Glyph, children }: { icon: Icon; children: ReactNode }) {
  return (
    <LabeledDivider role="status">
      <span className="flex max-w-4/5 min-w-0 items-start gap-1.5 text-center">
        <Glyph className="mt-0.5 size-icon-sm shrink-0" />
        <span className="min-w-0 wrap-break-word">{children}</span>
      </span>
    </LabeledDivider>
  );
}
