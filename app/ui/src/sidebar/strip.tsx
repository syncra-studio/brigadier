import type { ReactNode } from "react";

import { TooltipIconButton } from "../components/icon-button";
import { useSidebar } from "../components/sidebar";
import { newChat } from "../home/start";
import { MagnifyingGlassSearch, Plugin, PullRequestOpen } from "../icons";
import { BrigadierMark } from "../onboarding/mark";
import { openSearch } from "../palette/palette";
import { openSettings } from "../settings/shell";
import { keysOf } from "../shortcuts";
import { StripFoot } from "./foot";

/**
 * The strip, the rail, always at the window's start [D11]: the logo (Home), Search (⌘K), Plugins and Pull Requests;
 * while the sidebar is hidden, a rule, then the squares and their lists (`children`) [D189 D194 D55 D58]. That part scrolls
 * under a fade once it reaches the foot, which a rule then sets apart [D191]; the foot at the bottom [D56].
 */
export function Strip({ home, pulls, settings, children }: {
  /** Home shows. */
  home: boolean;
  /** The pull requests show. */
  pulls: boolean;
  /** The Settings page that shows. */
  settings?: string;
  children?: ReactNode;
}) {
  const { open } = useSidebar();
  return (
    <nav aria-label="Strip" className="rail strip-timeline flex h-full shrink-0 flex-col items-center pt-tab-bar pb-2">
      <div className="strip-scroll scroll-edge-fade edge-fade-group hide-scrollbar flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto pt-1.25">
        <TooltipIconButton look="rail" side="right" tooltip="Home" pressed={home} onClick={newChat}>
          <BrigadierMark className="size-icon-mark text-foreground" />
        </TooltipIconButton>
        <TooltipIconButton look="rail" side="right" tooltip="Search" shortcut={keysOf("search")[0]} onClick={openSearch}>
          <MagnifyingGlassSearch />
        </TooltipIconButton>
        <TooltipIconButton look="rail" side="right" tooltip="Plugins" pressed={settings === "plugins"} onClick={() => openSettings("plugins")}>
          <Plugin />
        </TooltipIconButton>
        <TooltipIconButton look="rail" side="right" tooltip="Pull Requests" pressed={pulls} onClick={() => (window.location.hash = "#pull-requests")}>
          <PullRequestOpen />
        </TooltipIconButton>
        {!open && children && (
          <>
            <span aria-hidden className="strip-rule" />
            <div className="strip-squares flex flex-col items-center gap-2">{children}</div>
          </>
        )}
      </div>
      <StripFoot settings={settings !== undefined && settings !== "plugins"} />
    </nav>
  );
}
