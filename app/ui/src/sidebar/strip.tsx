import type { ReactNode } from "react";

import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { ScrollFade } from "../components/scroll-fade";
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
 * a rule, the squares and their lists (`children`) [D189 D194 D55 D58]. Only the squares scroll, under a fade at
 * either end while there is more that way, and the foot's rule shows while they do [D191 D284]; the foot at the bottom,
 * its last button 4 from the window's foot [D56]. The top's buttons stand as close as the foot's, 2 apart [D280].
 */
/**
 * Brigadier's mark, Home: at the strip's top, and before the expanded sidebar's title [D192 D226]. Not a toggle: no
 * fill, hover, pressed or lit state and never dimmed, only the focus ring; a click goes Home [D288].
 */
export function HomeMark({ rail = false }: { rail?: boolean }) {
  return (
    <button type="button" aria-label="Home" onClick={newChat} className={cx("flex shrink-0 cursor-pointer items-center justify-center rounded-icon-button text-foreground focus-visible:focus-ring", rail ? "size-9" : "h-7 w-7.25")}>
      <BrigadierMark className="size-icon-mark" />
    </button>
  );
}

export function Strip({ pulls, settings, children }: {
  /** The pull requests show. */
  pulls: boolean;
  /** The Settings page that shows. */
  settings?: string;
  children?: ReactNode;
}) {
  const { setOpen } = useSidebar();
  return (
    <nav aria-label="Strip" className="rail scroll-fade-scope flex h-full shrink-0 flex-col items-center pt-tab-bar pb-1">
      {/* The actions stay put; only the squares between them and the foot scroll, faded at an end while there is more [D284]. */}
      <div className="flex w-full shrink-0 flex-col items-center gap-0.5 pt-1.25">
        <HomeMark rail />
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
        {children && <span aria-hidden className="strip-rule mt-1.5" />}
      </div>
      <div className="relative flex min-h-0 w-full flex-1 flex-col">
        <div className="scroll-fade-source hide-scrollbar flex min-h-0 flex-1 flex-col items-center overflow-y-auto pt-2">
          {children && <div className="strip-squares flex flex-col items-center gap-0.5">{children}</div>}
        </div>
        <ScrollFade side="top" whileMore />
        <ScrollFade whileMore />
      </div>
      <StripFoot settings={settings !== undefined && settings !== "plugins"} />
    </nav>
  );
}
