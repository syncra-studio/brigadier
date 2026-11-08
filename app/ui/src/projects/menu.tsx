import { DropdownMenuItem, DropdownMenuSeparator } from "../components/menu";
import { showToast } from "../components/toast";
import { ComposeEditSquare, FolderOpen, SettingsCog, Trash } from "../icons";
import { errorText, run } from "../onboarding/api";
import type { Project } from "./projects";
import { openRemoveProject } from "./remove";
import { openProjectSettings } from "./settings";
import { enterProject } from "./trust";

/**
 * A project's menu, the core four as the old app had them [D171, D212]: New session, Project settings…,
 * Reveal in Finder and Remove project… (1w). The sidebar's project row puts these in its ⋯ menu.
 */
export function ProjectMenuItems({ project }: { project: Pick<Project, "id" | "name"> }) {
  return (
    <>
      <DropdownMenuItem onClick={() => newSessionIn(project.id)}>
        <ComposeEditSquare />
        New session
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => openProjectSettings(project.id)}>
        <SettingsCog />
        Project settings…
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => void run(["projects", "reveal", project.id]).catch((cause) => showToast(`Couldn't reveal ${project.name}: ${errorText(cause)}`, { tone: "error" }))}
      >
        <FolderOpen />
        Reveal in Finder
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={() => openRemoveProject(project.id)}>
        <Trash />
        Remove project…
      </DropdownMenuItem>
    </>
  );
}

/** A new session in the project: Home, drafted there. */
export function newSessionIn(id: string): void {
  // shortcut: Home is the Start form with this project chosen, until 1s's draft takes the project.
  enterProject(id);
  window.location.hash = "";
}
