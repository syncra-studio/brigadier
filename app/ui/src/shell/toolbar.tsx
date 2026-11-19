import { type ReactNode, useState } from "react";

import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { TitlebarTips, Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { justStarted, useHomeDraft } from "../home/start";
import { Tasks } from "../icons";
import { useProjects } from "../projects/projects";
import { RightPanelToggle, useHasPanel } from "./right-panel";
import { useCardToggle } from "./summary-card";
import { CHAT, HOME, useTabs } from "./tab-store";

/** A control whose feature isn't built yet [D388]: drawn and named only. A disabled button hears no pointer, so its tip hangs on what holds it. */
function Drawn({ tooltip, className, inert, children }: { tooltip: string; className?: string | false; inert?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span inert={inert} className={cx("app-no-drag flex", className)} />}>
        <TooltipIconButton look="strip" tip={false} tooltip={tooltip} disabled>
          {children}
        </TooltipIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Context shows and hides the summary card where the chat has one [D1014]; elsewhere it's still drawn only. It's
 * there only while the chat's own tab is in front, folding away and back as the tab changes; the Files toggle at the
 * end holds still [D882].
 */
function ContextButton({ owner, className }: { owner: string; className?: string | false }) {
  const { shown, toggle } = useCardToggle(owner);
  const onChat = useTabs(owner).active === CHAT;
  const fold = cx("justify-center overflow-hidden transition-all duration-300 ease-sidebar motion-reduce:transition-none", onChat ? "w-8" : "w-0 scale-80 opacity-0", className);
  if (!useHasPanel(owner))
    return (
      <Drawn tooltip="Context" className={fold} inert={!onChat}>
        <Tasks />
      </Drawn>
    );
  return (
    <span inert={!onChat} className={cx("app-no-drag flex", fold)}>
      <TooltipIconButton look="strip" tooltip="Context" pressed={shown} onClick={toggle}>
        <Tasks />
      </TooltipIconButton>
    </span>
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
  if (home && !panel) return null;
  // Bare icons on the frame's grey [D828], at the tab bar's end on every platform, on Windows just before the caption buttons [D60].
  return (
    <div className="app-no-drag flex h-7.5 shrink-0 items-center gap-0.5">
      <TitlebarTips>
        {!home && <ContextButton owner={owner} className={enter} />}
        {/* The left toggle's icon, mirrored; the panel itself mounts in right-panel.tsx [D410, D56]. */}
        {panel && (
          <RightPanelToggle owner={owner} className={enter} />
        )}
      </TitlebarTips>
    </div>
  );
}
