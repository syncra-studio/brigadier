// Study only (D464, D466): the shapes studied thread notices take, drawn with our kit and theme tokens, to show
// beside ours. Nothing here ships; it goes before anything lands.
import type { ComponentType, ReactNode } from "react";

import { Button } from "../src/components/button";
import { ComposerCard } from "../src/components/composer/composer";
import { ComposerRail, RailItem } from "../src/components/composer/rail";
import { cx } from "../src/components/cx";
import { LabeledDivider } from "../src/components/labeled-divider";
import { Tooltip, TooltipContent, TooltipTrigger } from "../src/components/tooltip";
import { Info, type IconProps } from "../src/icons";
import { Row } from "./parts";

type Icon = ComponentType<IconProps>;

/** One kind: where it sits and what brings it, then the studied look and ours side by side. */
export function Kind({ name, where, ours, children }: { name: string; where: string; ours?: ReactNode; children: ReactNode }) {
  return (
    <Row name={name}>
      <p className="w-full -mt-1 text-xs text-muted-foreground">{where}</p>
      <Column label="Theirs, drawn with our kit">{children}</Column>
      <Column label="Ours today">{ours ?? <Note>We have none.</Note>}</Column>
    </Row>
  );
}

function Column({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex w-96 flex-col gap-2">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

/** A plain remark where a look can't be drawn on its own (a tooltip, a toast, a whole screen elsewhere). */
export function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm text-faint-foreground">{children}</p>;
}

/** A state's caption inside a column. */
export function Caption({ children }: { children: ReactNode }) {
  return <span className="text-2xs text-faint-foreground">{children}</span>;
}

/** An ⓘ that tells the rest on hover or focus. */
export function Tip({ text }: { text: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span role="img" tabIndex={0} aria-label="Details" className="flex shrink-0 rounded-control hover:text-foreground focus-visible:focus-ring">
            <Info className="size-icon-xs" />
          </span>
        }
      />
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

/** Its divider: words between two hairlines, an icon before them and an ⓘ after where it has them. */
export function Divider({ icon: Glyph, tip, live, children }: { icon?: Icon; tip?: ReactNode; live?: boolean; children: ReactNode }) {
  return (
    <LabeledDivider>
      <span className="flex min-w-0 items-center gap-1.5 text-center">
        {Glyph && <Glyph className="size-icon-sm shrink-0" />}
        <span className={cx("min-w-0", live && "shimmer")}>{children}</span>
        {tip && <Tip text={tip} />}
      </span>
    </LabeledDivider>
  );
}

/** Its inline status that wraps: the divider's rules, an icon, then a sentence that may take two lines. */
export function Inline({ icon: Glyph, children }: { icon: Icon; children: ReactNode }) {
  return (
    <LabeledDivider>
      <span className="flex min-w-0 max-w-4/5 items-start gap-1.5 text-center">
        <Glyph className="mt-0.5 size-icon-sm shrink-0" />
        <span className="min-w-0">{children}</span>
      </span>
    </LabeledDivider>
  );
}

/** A quiet status line in the reply's place. */
export function Status({ live, children }: { live?: boolean; children: ReactNode }) {
  return <p className={cx("text-sm leading-5.25 text-muted-foreground", live && "shimmer")}>{children}</p>;
}

/** Its turn-error card in the thread: big round corners, a hairline, an icon, muted words, buttons at the end. */
export function Banner({ icon: Glyph, title, actions, children }: { icon: Icon; title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div role="alert" className="flex w-full flex-wrap items-center gap-3 rounded-alert border border-border bg-card py-4 ps-5 pe-3 text-sm text-muted-foreground">
      <Glyph className="mt-0.5 size-icon-sm shrink-0 self-start" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title && <p className="font-semibold text-foreground">{title}</p>}
        <p className="wrap-anywhere">{children}</p>
      </div>
      {actions && <div className="ms-auto flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}

/** Plain chat's failed answer: a red-washed callout with its one button. */
export function Callout({ action, children }: { action?: string; children: ReactNode }) {
  return (
    <div role="alert" className="flex w-full flex-wrap items-center gap-3 rounded-control border border-destructive-border bg-destructive-wash px-4 py-3 text-sm text-destructive">
      <p className="min-w-0 flex-1">{children}</p>
      {action && (
        <Button size="sm" className="ms-auto">
          {action}
        </Button>
      )}
    </div>
  );
}

/** A whole-chat state in the thread's place: title, line, buttons, centred. */
export function Page({ icon: Glyph, title, detail, actions }: { icon?: Icon; title: string; detail?: ReactNode; actions?: ReactNode }) {
  return (
    <div role="status" className="flex flex-col items-center gap-1.5 rounded-surface border border-divider px-4 py-6 text-center text-sm">
      {Glyph && <Glyph className="size-icon-lg text-quiet-foreground" />}
      <p className="font-medium text-foreground">{title}</p>
      {detail && <p className="text-label text-quiet-foreground">{detail}</p>}
      {actions && <div className="flex gap-2 pt-2">{actions}</div>}
    </div>
  );
}

/** A strip above the composer, tucked under its card the way ours tucks the rail. */
export function AboveComposer({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <ComposerRail>
        <RailItem label="Notice">
          <div className="flex flex-wrap items-center gap-2 py-2 ps-3.5 pe-2.5 text-label text-foreground">{children}</div>
        </RailItem>
      </ComposerRail>
      <ComposerCard>
        <p className="px-2 py-1.5 text-sm text-placeholder">Ask anything</p>
      </ComposerCard>
    </div>
  );
}

/** A toast, as it pops up at the window's edge. */
export function Toast({ children }: { children: ReactNode }) {
  return <p className="w-fit rounded-overlay bg-popover px-3.5 py-2 text-sm text-foreground shadow-overlay ring ring-border">{children}</p>;
}
