import { type ReactNode, useState } from "react";

import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { TitlebarTips, Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { justStarted, useHomeDraft } from "../home/start";
import { Tasks } from "../icons";
import { useProjects } from "../projects/projects";
import { RightPanelToggle } from "./right-panel";
import { HOME } from "./tab-store";

/** A control whose feature isn't built yet [D388]: drawn and named only. A disabled button hears no pointer, so its tip hangs on what holds it. */
function Drawn({ tooltip, className, children }: { tooltip: string; className?: string | false; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cx("app-no-drag flex", className)} />}>
        <TooltipIconButton look="toolbar" tip={false} tooltip={tooltip} disabled>
          {children}
        </TooltipIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * One toolbar for Home, chats and sessions, in the old app's order [D360]; terminals are tabs only [D418]. Context
 * waits for the first message [D420], and Home's new chat, in no project, has no right panel [D421]. What the first
 * message brings fades in; opening a session that has them shows them at once.
 */
export function Toolbar({ owner }: { owner: string }) {
  const home = owner === HOME;
  const draft = useHomeDraft();
  const projects = useProjects();
  const [fresh] = useState(() => justStarted(owner));
  const enter = fresh && "motion-safe:animate-fade-in";
  const panel = !home || (!draft.chat && Boolean(projects?.some((each) => !each.pending)));
  return (
    <TitlebarTips>
      {!home && (
        <Drawn tooltip="Context" className={enter}>
          <Tasks />
        </Drawn>
      )}
      {/* The left toggle's folded icon, mirrored; the panel itself mounts in right-panel.tsx [D410]. */}
      {panel && (
        <RightPanelToggle owner={owner} className={enter} />
      )}
    </TitlebarTips>
  );
}
