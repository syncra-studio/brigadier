// The gallery's own layout: rows of frozen states, and tips held open in place.
import { type ReactElement, type ReactNode, useState } from "react";

import { cx } from "../src/components/cx";
import { Kbd } from "../src/components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "../src/components/tooltip";

/**
 * Holds a popup open in the page: it's placed inside this box, which `transform-gpu` makes the frame a dialog's
 * fixed position measures from.
 */
export function Held({ className, children }: { className: string; children: (box: HTMLDivElement) => ReactNode }) {
  // The box must exist before the popup mounts, or Base UI places it in the page body instead.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setBox} data-held className={cx("relative transform-gpu", className)}>
      {box && children(box)}
    </div>
  );
}

/** One area of the page: its name, then its components' blocks. */
export function Area({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div data-area={name} className="flex flex-col gap-6">
      <h2 className="font-display text-xl font-semibold">{name}</h2>
      {children}
    </div>
  );
}

/** One component's block, bounded, its name staying on top while the block is on screen. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section data-block={title} className="scroll-mt-4 rounded-surface border border-border">
      <h3 className="sticky top-0 z-10 rounded-t-surface border-b border-divider bg-card px-5 py-3 text-sm font-semibold">{title}</h3>
      <div className="flex flex-col gap-8 p-5">{children}</div>
    </section>
  );
}

/** A set of states side by side; `name` titles it where its block holds more than one. */
export function Row({ name, children }: { name?: string; children: ReactNode }) {
  return (
    <div data-row={name} className="flex scroll-mt-16 flex-col gap-3 not-first:border-t not-first:border-divider not-first:pt-8">
      {name && <h4 className="text-label font-medium">{name}</h4>}
      <div className="flex flex-wrap items-start gap-x-8 gap-y-4">{children}</div>
    </div>
  );
}

/** One state. `frozen` holds hover, focus or active still (theme.css custom variants). */
export function State({ label, frozen, children }: { label: string; frozen?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <div data-frozen={frozen} className="flex items-center gap-3">
        {children}
      </div>
    </div>
  );
}

/** A tip held open beside its trigger, placed inside the gallery so the row's theme reaches it. */
export function OpenTip({
  trigger,
  label,
  shortcut,
  side = "bottom",
  wide,
}: {
  trigger: ReactElement;
  label: string;
  shortcut?: string;
  side?: "top" | "bottom";
  /** Room for a tip wider than its trigger. */
  wide?: boolean;
}) {
  // The box must exist before the tip mounts, or Base UI places it in the page body instead.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setBox} className={cx("relative flex justify-center", side === "bottom" ? "pb-10" : "pt-10", wide && "min-w-80 pb-16")}>
      <Tooltip open={box !== null}>
        <TooltipTrigger render={trigger} />
        {/* Held in place: a frozen tip never shifts to stay in view. */}
        <TooltipContent side={side} container={box} collisionAvoidance={{ side: "none", align: "none" }}>
          {label}
          {shortcut && <Kbd>{shortcut}</Kbd>}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
