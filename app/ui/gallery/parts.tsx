// The gallery's own layout: areas, a block per component, and rows of its variants side by side.
import type { ReactNode } from "react";

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

/** One variant, labelled. */
export function State({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-3">
        {children}
      </div>
    </div>
  );
}
