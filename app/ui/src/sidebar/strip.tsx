import type { ReactNode } from "react";

import { TooltipIconButton } from "../components/icon-button";
import { useSidebar } from "../components/sidebar";
import { newChat } from "../home/start";
import { ComposeEditSquare, MagnifyingGlassSearch, Plugin, PullRequestOpen } from "../icons";
import { BrigadierMark } from "../onboarding/mark";
import { openSearch } from "../palette/palette";
import { openSettings } from "../settings/shell";
import { keysOf } from "../shortcuts";
import { StripFoot } from "./foot";

/**
 * The strip, the rail, the sidebar folded [D11 D226]: the logo (Home), New chat [D265], Search (⌘K), Plugins and
 * Pull Requests; then
 * a rule, the squares and their lists (`children`) [D189 D194 D55 D58]. That part scrolls
 * under a fade once it reaches the foot, which a rule then sets apart [D191]; the foot at the bottom, its last button 4 from
 * the window's foot [D56]. The top's buttons stand as close as the foot's, 2 apart [D280].
 */
/** Brigadier's mark, Home: at the strip's top, and before the expanded sidebar's title [D192 D226]. */
export function HomeMark({ rail = false, pressed }: { rail?: boolean; pressed?: boolean }) {
  return (
    <TooltipIconButton look={rail ? "rail" : "head"} side={rail ? "right" : "bottom"} tooltip="Home" pressed={pressed} onClick={newChat}>
      <BrigadierMark className="size-icon-mark text-foreground" />
    </TooltipIconButton>
  );
}

export function Strip({ home, pulls, settings, children }: {
  /** Home shows. */
  home: boolean;
  /** The pull requests show. */
  pulls: boolean;
  /** The Settings page that shows. */
  settings?: string;
  children?: ReactNode;
}) {
  const { setOpen } = useSidebar();
  return (
    <nav aria-label="Strip" className="rail strip-timeline flex h-full shrink-0 flex-col items-center pt-tab-bar pb-1">
      <div className="strip-scroll scroll-edge-fade edge-fade-group hide-scrollbar flex min-h-0 w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto pt-1.25">
        <HomeMark rail pressed={home} />
        <TooltipIconButton look="rail" side="right" tooltip="New chat" onClick={newChat}>
          <ComposeEditSquare />
        </TooltipIconButton>
        <TooltipIconButton look="rail" side="right" tooltip="Search" shortcut={keysOf("search")[0]} onClick={openSearch}>
          <MagnifyingGlassSearch />
        </TooltipIconButton>
        <TooltipIconButton look="rail" side="right" tooltip="Plugins" pressed={settings === "plugins"} onClick={() => openSettings("plugins")}>
          <Plugin />
        </TooltipIconButton>
        <TooltipIconButton
          look="rail"
          side="right"
          tooltip="Pull Requests"
          pressed={pulls}
          onClick={() => {
            // The page and the sidebar with its list, as the toggle shows it [D236].
            setOpen(true);
            window.location.hash = "#pull-requests";
          }}
        >
          <PullRequestOpen />
        </TooltipIconButton>
        {children && (
          <>
            <span aria-hidden className="strip-rule my-1.5" />
            <div className="strip-squares flex flex-col items-center gap-0.5">{children}</div>
          </>
        )}
      </div>
      <StripFoot settings={settings !== undefined && settings !== "plugins"} />
    </nav>
  );
}
