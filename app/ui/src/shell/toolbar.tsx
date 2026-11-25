import { useState } from "react";

import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { TitlebarTips, Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { justStarted } from "../home/start";
import { Tasks } from "../icons";
import { RightPanelToggle, useHasPanel } from "./right-panel";
import { useCardToggle } from "./summary-card";
import { CHAT, HOME, useTabs } from "./tab-store";

/**
 * Toggle pinned summary: shows and hides the summary card where the chat has one [D39 D132]; elsewhere, and
 * while another tab is in front, it's disabled in its place. A disabled button hears no pointer, so its tip hangs on what holds it.
 */
function ContextButton({ owner, className }: { owner: string; className: string }) {
  const { shown, toggle } = useCardToggle(owner);
  const onChat = useTabs(owner).active === CHAT;
  const has = useHasPanel(owner);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cx("app-no-drag flex", className)} />}>
        <TooltipIconButton look="bar" tip={false} tooltip="Toggle pinned summary" data-summary-toggle pressed={has ? shown : undefined} disabled={!has || !onChat} onClick={toggle}>
          <Tasks />
        </TooltipIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">Toggle pinned summary</TooltipContent>
    </Tooltip>
  );
}

/**
 * The row's end [D38 D39 D40 D360]: Context, then Files; the chat's "…" is
 * on its tab (chat-tab.tsx) [D200].
 * Context waits for the first message [D420], and Home's new chat, in no project, has no right panel [D421]. What the
 * first message brings fades in; opening a session that has them shows them at once.
 */
export function Toolbar({ owner }: { owner: string }) {
  const home = owner === HOME;
  const [fresh] = useState(() => justStarted(owner));
  const enter = fresh ? "motion-safe:animate-fade-in" : "";
  const panel = useHasPanel(owner);
  if (home && !panel) return null;
  // On every platform, on Windows just before the caption buttons [D60].
  return (
    <div className="app-no-drag flex shrink-0 items-center gap-2">
      <TitlebarTips>
        {!home && <ContextButton owner={owner} className={enter} />}
        {panel && <RightPanelToggle owner={owner} className={enter} />}
      </TitlebarTips>
    </div>
  );
}
