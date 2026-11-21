import { type ReactNode, useEffect } from "react";

import { TooltipIconButton } from "../components/icon-button";
import { useSidebar } from "../components/sidebar";
import { newChat } from "../home/start";
import { Folder, Plugin } from "../icons";
import { BrigadierMark } from "../onboarding/mark";
import { openProject } from "../projects/page";
import { useProjects } from "../projects/projects";
import { openAddProject } from "../projects/store";
import { openSettings } from "../settings/shell";
import { Squares } from "./flyout";
import { StripFoot } from "./foot";

/** The project page last shown, for the strip's Projects [D75]. */
const LAST_PROJECT = "strip.project";

/**
 * The strip, the rail, always at the window's start [D11]: the logo (Home), Plugins and Projects, no rule between
 * [D12 D14 D16 D17]; while the sidebar is hidden, the squares and their lists (`children`) under them [D55 D58]; the foot
 * at its bottom [D56].
 */
export function Strip({ home, page, settings, front, children }: {
  /** Home shows. */
  home: boolean;
  /** The project whose page shows. */
  page?: string;
  /** The Settings page that shows. */
  settings?: string;
  /** The open session's project. */
  front?: string | null;
  children?: ReactNode;
}) {
  const { open } = useSidebar();
  const projects = useProjects();
  useEffect(() => {
    if (page) localStorage.setItem(LAST_PROJECT, page);
  }, [page]);
  // The open session's project's page, else the last one shown, else the first, else Add project [D75].
  const openProjects = () => {
    const known = (id: string | null | undefined) => (id && projects?.some((project) => project.id === id) ? id : null);
    const id = known(front) ?? known(localStorage.getItem(LAST_PROJECT)) ?? projects?.toSorted((a, b) => a.name.localeCompare(b.name))[0]?.id;
    if (id) openProject(id);
    else openAddProject();
  };
  return (
    <nav aria-label="Strip" className="rail flex h-full shrink-0 flex-col items-center gap-2 pt-tab-bar pb-2">
      <div className="flex flex-col items-center gap-2 pt-1.25">
        <TooltipIconButton look="rail" side="right" tooltip="Home" pressed={home} onClick={newChat}>
          <BrigadierMark className="size-icon-lg" />
        </TooltipIconButton>
        <TooltipIconButton look="rail" side="right" tooltip="Plugins" pressed={settings === "plugins"} onClick={() => openSettings("plugins")}>
          <Plugin />
        </TooltipIconButton>
        <TooltipIconButton look="rail" side="right" tooltip="Projects" pressed={page !== undefined} onClick={openProjects}>
          <Folder />
        </TooltipIconButton>
      </div>
      {!open && children ? <Squares>{children}</Squares> : <div className="flex-1" />}
      <StripFoot />
    </nav>
  );
}
