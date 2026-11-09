import { newSession } from "../home/start";
import { copyWithToast } from "../components/copy-button";
import { DropdownMenuItem, DropdownMenuSeparator } from "../components/menu";
import { showToast } from "../components/toast";
import { ComposeEditSquare, Copy, FolderOpen, SettingsCog, Trash } from "../icons";
import { errorText, run } from "../onboarding/api";
import type { Project } from "./projects";
import { openRemoveProject } from "./remove";
import { openProjectSettings } from "./settings";

/**
 * A project's menu, the core four as the old app had them [D171, D212]: New session, Project settings…,
 * Reveal in Finder and Remove project… (1w), plus Copy path. The sidebar's project row puts these in its ⋯ menu.
 */
export function ProjectMenuItems({ project }: { project: Pick<Project, "id" | "name" | "folder"> }) {
  return (
    <>
      <DropdownMenuItem onClick={() => newSessionIn(project.id)}>
        <ComposeEditSquare />
        New session
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => openProjectSettings(project.id)}>
        <SettingsCog />
        Project settings
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => void run(["projects", "reveal", project.id]).catch((cause) => showToast(`Couldn't reveal ${project.name}: ${errorText(cause)}`, { tone: "error" }))}
      >
        <FolderOpen />
        Reveal in Finder
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => copyWithToast(project.folder, "path")}>
        <Copy />
        Copy path
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={() => openRemoveProject(project.id)}>
        <Trash />
        Remove project
      </DropdownMenuItem>
    </>
  );
}

/** A new session in the project: Home, drafted there. */
export function newSessionIn(id: string): void {
  newSession(id);
}
