// The right panel [D410, D1014] and its toggle [D1025]: each state side by side, then one live copy.
import type { ReactNode } from "react";

import { TitlebarTips } from "../src/components/tooltip";
import type { PanelHint, PanelView } from "../src/panel/types";
import { VIEWS } from "../src/panel/views";
import { hintWords } from "../src/panel/words";
import { PanelToggleButton, RightPanelSlot, RightPanelToggle, ViewTabs } from "../src/shell/right-panel";
import { OpenTip, Row, Section, State } from "./parts";

/** The panel's column at its default width. */
export function PanelFrame({ children, className = "h-120" }: { children: ReactNode; className?: string }) {
  return <div className={`relative flex w-80 flex-col overflow-hidden rounded-surface border border-border bg-background ${className}`}>{children}</div>;
}

const HINTS: [string, PanelHint | null][] = [
  ["Nothing to do", null],
  ["Changes", { tone: "changes", count: 3 }],
  ["Ready to merge", { tone: "ready", base: "main" }],
  ["Would conflict", { tone: "conflict", base: "main" }],
  ["Checks failed", { tone: "failed", pr: 12, why: "checks" }],
];

const TABS: PanelView[] = ["files", "source"];

export function RightPanelGallery() {
  return (
    <Section title="Right panel: frame and toggle">
      <Row name="The toggle: its dot and tip follow the most urgent state">
        {/* No TitlebarTips here: its delay keeps a held tip from showing. */}
        {HINTS.map(([label, hint]) => (
            <State key={label} label={label}>
              <OpenTip trigger={<PanelToggleButton hint={hint} open={false} tip={false} />} label={hintWords(hint)} shortcut="⌥⌘B" wide />
            </State>
          ))}
        <State label="Open, on Source: the dot hides">
          <PanelToggleButton hint={null} open />
        </State>
      </Row>
      <Row name="The panel on each view">
        {TABS.map((view) => {
          const { View } = VIEWS[view];
          return (
            <State key={view} label={view}>
              <PanelFrame>
                <ViewTabs active={view} count={3} onSelect={() => undefined} />
                <View owner={`g-panel-${view}`} />
              </PanelFrame>
            </State>
          );
        })}
      </Row>
      <Row name="Source's count">
        <State label="3">
          <ViewTabs active="files" count={3} onSelect={() => undefined} />
        </State>
        <State label="Over 99">
          <ViewTabs active="files" count={120} onSelect={() => undefined} />
        </State>
        <State label="None">
          <ViewTabs active="files" count={0} onSelect={() => undefined} />
        </State>
      </Row>
      <Row name="Live: the toggle, ⌥⌘B, ⇧⌘E ⌃⇧G, and the edge drags to resize (below half its least width, it closes)">
        <div className="flex h-140 w-full min-w-200 overflow-hidden rounded-surface border border-border bg-chrome">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-titlebar shrink-0 items-center justify-end px-2">
              <TitlebarTips>
                <RightPanelToggle owner="g-panel-live" />
              </TitlebarTips>
            </div>
            <p className="m-auto text-sm text-muted-foreground">The chat</p>
          </div>
          <RightPanelSlot owner="g-panel-live" />
        </div>
      </Row>
    </Section>
  );
}
