// The wave 2 landing views' gallery helpers: a composer with the chips they leave, and frames at the tab's size.
import type { ReactNode } from "react";

import { ComposerCard } from "../src/components/composer/composer";
import { cx } from "../src/components/cx";
import { type AgentChip, AgentChipTile } from "../src/landing/agent-chip";

/** The composer card with what waits for the agent above its field; nothing is sent from here [D1019]. */
export function ChipsComposer({ chips, onRemove }: { chips: readonly AgentChip[]; onRemove: (id: string) => void }) {
  return (
    <div className="w-140">
      <ComposerCard>
        {chips.length > 0 && (
          <div data-slot="composer-attachments" className="flex w-full flex-wrap items-end gap-2 px-1 pt-1 pb-1.5">
            {chips.map((chip) => (
              <AgentChipTile key={chip.id} chip={chip} onRemove={() => onRemove(chip.id)} />
            ))}
          </div>
        )}
        <p className="min-h-16 px-2 py-1 text-sm text-muted-foreground">Ask for follow-up changes</p>
      </ComposerCard>
    </div>
  );
}

/** A main-area tab's room, as the old mocks framed it. */
export function TabFrame({ children, tall = false }: { children: ReactNode; tall?: boolean }) {
  return <div className={cx("flex w-190 flex-col overflow-hidden rounded-surface border border-border bg-background", tall ? "h-160" : "h-105")}>{children}</div>;
}
