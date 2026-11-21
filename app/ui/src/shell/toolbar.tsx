import { type ReactNode, useState } from "react";

import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../components/menu";
import { TitlebarTips, Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { justStarted, useHomeDraft } from "../home/start";
import { DotsHorizontal, Tasks } from "../icons";
import { useProjects } from "../projects/projects";
import { rename } from "../sidebar/actions";
import { RenameDialog, RowMenuItems } from "../sidebar/menu";
import type { SessionRow } from "../sidebar/words";
import { RightPanelToggle, useHasPanel } from "./right-panel";
import { useCardToggle } from "./summary-card";
import { CHAT, HOME, useTabs } from "./tab-store";

/** A control whose feature isn't built yet [D388]: drawn and named only. A disabled button hears no pointer, so its tip hangs on what holds it. */
function Drawn({ tooltip, className, inert, children }: { tooltip: string; className?: string | false; inert?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span inert={inert} className={cx("app-no-drag flex", className)} />}>
        <TooltipIconButton look="bar" tip={false} tooltip={tooltip} disabled>
          {children}
        </TooltipIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** The chat's own controls show only while its tab is in front, folding away and back as the tab changes [D882]. */
const fold = (onChat: boolean) => cx("justify-center overflow-hidden transition-all duration-300 ease-sidebar motion-reduce:transition-none", onChat ? "w-7" : "-me-1.5 w-0 scale-80 opacity-0");

/** The Chat actions [D37]: the session's row menu, as its sidebar row's ⋯ [D185]. */
function ChatActions({ row, inert, className }: { row: SessionRow; inert: boolean; className: string }) {
  const [renaming, setRenaming] = useState(false);
  return (
    <span inert={inert} className={cx("app-no-drag flex", className)}>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger render={<TooltipIconButton look="bar" tooltip="Chat actions" />}>
          <DotsHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <RowMenuItems row={row} onRename={() => setRenaming(true)} />
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDialog row={renaming ? row : null} onClose={() => setRenaming(false)} onRename={(name, branch) => rename(row, name, branch)} />
    </span>
  );
}

/**
 * Context shows and hides the summary card where the chat has one, in the Toggle pinned summary spot [D39 D1014];
 * elsewhere it's still drawn only.
 */
function ContextButton({ owner, className }: { owner: string; className: string }) {
  const { shown, toggle } = useCardToggle(owner);
  const onChat = useTabs(owner).active === CHAT;
  if (!useHasPanel(owner))
    return (
      <Drawn tooltip="Context" className={className} inert={!onChat}>
        <Tasks />
      </Drawn>
    );
  return (
    <span inert={!onChat} className={cx("app-no-drag flex", className)}>
      <TooltipIconButton look="bar" tooltip="Context" pressed={shown} onClick={toggle}>
        <Tasks />
      </TooltipIconButton>
    </span>
  );
}

/**
 * The row's end, the chat toolbar then Show tabs [D38 D39 D40 D360]: the chat's "…", Context, then Files.
 * Context waits for the first message [D420], and Home's new chat, in no project, has no right panel [D421]. What the
 * first message brings fades in; opening a session that has them shows them at once.
 */
export function Toolbar({ owner, row }: { owner: string; row?: SessionRow | undefined }) {
  const home = owner === HOME;
  const draft = useHomeDraft();
  const projects = useProjects();
  const onChat = useTabs(owner).active === CHAT;
  const [fresh] = useState(() => justStarted(owner));
  const enter = fresh ? "motion-safe:animate-fade-in" : "";
  const panel = !home || (!draft.chat && Boolean(projects?.some((each) => !each.pending)));
  if (home && !panel) return null;
  // On every platform, on Windows just before the caption buttons [D60].
  return (
    <div className="app-no-drag flex shrink-0 items-center gap-1.5">
      <TitlebarTips>
        {row && !row.archived && <ChatActions row={row} inert={!onChat} className={cx(fold(onChat), enter)} />}
        {!home && <ContextButton owner={owner} className={cx(fold(onChat), enter)} />}
        {panel && <RightPanelToggle owner={owner} className={enter} />}
      </TitlebarTips>
    </div>
  );
}
