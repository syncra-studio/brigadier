// Files [D1284] and git failures above the composer [D1264, D1293].
import { useEffect } from "react";

import { ComposerCard } from "../src/components/composer/composer";
import { ComposerRail, Notices } from "../src/components/composer/rail";
import { TitlebarTips } from "../src/components/tooltip";
import { gitFailed, useGitNotice } from "../src/panel/notice";
import { PanelToggleButton, RightPanelSlot, RightPanelToggle } from "../src/shell/right-panel";
import { OpenTip, Row, Section, State } from "./parts";

function GitFailure({ writer = false }: { writer?: boolean }) {
  const session = writer ? "g-git-writer" : "g-git-push";
  const git = useGitNotice(session);
  useEffect(() => {
    gitFailed(
      { session },
      writer ? "Couldn't write a commit message." : "The remote refused the push.",
      writer ? "The message writer couldn't connect. Nothing was committed." : "To /tmp/demo/origin.git\n ! [rejected] brigadier/demo -> brigadier/demo (fetch first)",
      writer,
    );
  }, [session, writer]);
  return (
    <div className="w-140">
      <ComposerRail><Notices notices={git.notice ? [git.notice] : []} onDismiss={git.dismiss} /></ComposerRail>
      <ComposerCard>
        <textarea aria-label="Message" placeholder="Ask for follow-up changes" className="min-h-16 w-full resize-none bg-transparent px-2 py-1 text-sm outline-none" />
      </ComposerCard>
      {git.dialog}
    </div>
  );
}

export function RightPanelGallery() {
  return (
    <Section title="Files: frame and toggle">
      <Row name="The toggle">
        {/* No TitlebarTips here: its delay keeps a held tip from showing. */}
        <State label="Closed, its tip">
          <OpenTip trigger={<PanelToggleButton open={false} tip={false} />} label="Files" shortcut="⇧⌘E" wide />
        </State>
        <State label="Open">
          <PanelToggleButton open />
        </State>
      </Row>
      <Row name="Git failures above the composer">
        <State label="Refused push: Details opens git's words"><GitFailure /></State>
        <State label="Writer failed: Type a message…"><GitFailure writer /></State>
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
