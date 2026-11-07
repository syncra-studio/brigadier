// The gallery's own layout: rows of frozen states, and tips held open in place.
import { type ReactElement, type ReactNode, useState } from "react";

import { cx } from "../src/components/cx";
import { Kbd } from "../src/components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "../src/components/tooltip";
import * as Current from "./final";
import * as Old from "./old";

/** A set of the components a row shows: the kit (Current) or the old-exact copies (Old app). */
export type KitSet = typeof Current;
// In the order of the header's columns.
const SETS: KitSet[] = [Current, Old];

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-6 border-t border-divider pt-6 first:border-0 first:pt-0">
      <h2 className="font-display text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** One component's row: each state side by side, once with the kit (Current) and once as the old app had it. */
export function Row({ name, children }: { name: string; children: (k: KitSet) => ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-label text-muted-foreground">{name}</h3>
      <div className="grid grid-cols-2">
        {SETS.map((k, i) => (
          <div key={i} className={cx("flex flex-wrap items-start gap-x-8 gap-y-4", i === 0 ? "pe-6" : "old-app-colours border-s border-divider ps-6")}>
            {children(k)}
          </div>
        ))}
      </div>
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

