// The right panel [D410, D1014] and its toggle: the toggle's states, then one live copy.
import { TitlebarTips } from "../src/components/tooltip";
import { PanelToggleButton, RightPanelSlot, RightPanelToggle } from "../src/shell/right-panel";
import { OpenTip, Row, Section, State } from "./parts";

export function RightPanelGallery() {
  return (
    <Section title="Right panel: frame and toggle">
      <Row name="The toggle">
        {/* No TitlebarTips here: its delay keeps a held tip from showing. */}
        <State label="Closed, its tip">
          <OpenTip trigger={<PanelToggleButton open={false} tip={false} />} label="Right sidebar" shortcut="⌥⌘B" wide />
        </State>
        <State label="Open">
          <PanelToggleButton open />
        </State>
      </Row>
      <Row name="Live: the toggle, ⌥⌘B, ⇧⌘E, and the edge drags to resize (below half its least width, it closes)">
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
