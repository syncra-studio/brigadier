import type { ReactNode } from "react";

import { TooltipIconButton } from "../components/icon-button";
import { TitlebarTips, Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Dock, SidebarFloatingLeft, Tasks } from "../icons";
import { openTab } from "./tab-store";

/** A control whose feature isn't built yet [D388]: drawn and named only. A disabled button hears no pointer, so its tip hangs on what holds it. */
function Drawn({ tooltip, children }: { tooltip: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="app-no-drag flex" />}>
        <TooltipIconButton look="toolbar" tip={false} tooltip={tooltip} disabled>
          {children}
        </TooltipIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** One toolbar for Home, chats and sessions, in the old app's order [D360]. */
export function Toolbar({ owner, archived }: { owner: string; archived: boolean }) {
  return (
    <TitlebarTips>
      <Drawn tooltip="Context">
        <Tasks />
      </Drawn>
      {/* Proposed: with no bottom panel [D360], this opens a Terminal tab rather than toggling one. */}
      <TooltipIconButton look="toolbar" tooltip="Terminal" shortcut="⌘J" className="app-no-drag" disabled={archived} onClick={() => openTab(owner, "terminal")}>
        <Dock />
      </TooltipIconButton>
      {/* The left toggle's folded icon, mirrored; the panel itself mounts in right-panel.tsx [D410]. */}
      <Drawn tooltip="Right sidebar">
        <SidebarFloatingLeft className="-scale-x-100" />
      </Drawn>
    </TitlebarTips>
  );
}
