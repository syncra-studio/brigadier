// The gallery's own layout: rows of frozen states, and tips held open in place.
import { type ReactElement, type ReactNode, useState } from "react";

import { cx } from "../src/components/cx";
import { Kbd } from "../src/components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "../src/components/tooltip";
import * as Current from "./current";

/** Slice 2's components, as the kit has them. */
export type KitSet = typeof Current;

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-6 border-t border-divider pt-6 first:border-0 first:pt-0">
      <h2 className="font-display text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** One component's row: each state side by side. */
export function Row({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-label text-muted-foreground">{name}</h3>
      <div className="flex flex-wrap items-start gap-x-8 gap-y-4">{children}</div>
    </div>
  );
}

/** One component's row, given the kit's slice 2 set. */
export function KitRow({ name, children }: { name: string; children: (k: KitSet) => ReactNode }) {
  return <Row name={name}>{children(Current)}</Row>;
}

/**
 * A row shown twice (D22): as the kit has it (Current), and as the old app drew it (Old app). The old
 * column is the same components with the old app's arrow cursor, no press and its own red (theme.css
 * `old-app`); it goes once the owner approves.
 */
export function Compare({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-label text-muted-foreground">{name}</h3>
      <div className="grid grid-cols-2">
        {["Current", "Old app"].map((label, i) => (
          <div key={label} className={cx("flex min-w-0 flex-col gap-3", i === 0 ? "pe-6" : "old-app border-s border-divider ps-6")}>
            <span className="text-2xs font-medium">{label}</span>
            <div className="flex flex-wrap items-start gap-x-8 gap-y-4">{children}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A box a frozen popup is held open in, so it shows in the page beside its trigger instead of over it.
 * `transform-gpu` makes it the frame a dialog's fixed position measures from.
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
