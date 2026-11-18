import { type FormEvent } from "react";

import { Button } from "../components/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../components/dialog";
import { Spinner } from "../icons";
import { useProjectSources } from "../onboarding/projects";
import { useDaemon } from "../daemon";
import { closeAddProject, daemonSource, showProject, type Source, useAddProject } from "./store";

/*
 * Add project as onboarding's Projects step [D668]: its Clone / Existing folder / New tabs, several at a time, with
 * Cancel. ⌘O's folder comes in picked; a project already added shows itself instead.
 */

export { shortPath } from "../onboarding/sources";

/** Mounted once; opened by `openAddProject` from anywhere. `offline` while the daemon is away. */
export function AddProjectDialog({ source, offline }: { source: Source; offline: boolean }) {
  const { open, path, opening } = useAddProject();
  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeAddProject()}>
      <DialogContent frame="project-dialog max-w-add-project gap-0 p-0">{open && <AddProject key={opening} source={source} offline={offline} initialPath={path} />}</DialogContent>
    </Dialog>
  );
}

/** The app's Add project, on the daemon. */
export function AddProjectHost() {
  return <AddProjectDialog source={daemonSource} offline={useDaemon().daemon === null} />;
}

const shown = (id: string | undefined) => {
  closeAddProject();
  if (id) showProject(id);
};

export function AddProject({ source, offline, initialPath = "" }: { source: Source; offline: boolean; initialPath?: string }) {
  const { body, tab, picks, folder, hint, adding, disabled, finish } = useProjectSources({ source, offline, initialPath, onExisting: shown, onDone: (ids) => shown(ids[0]) });
  const label =
    tab === "clone"
      ? adding ? "Cloning…" : picks.length > 1 ? `Clone ${picks.length} repos` : "Clone and add"
      : tab === "new"
        ? adding ? "Creating…" : "Create and add"
        : adding ? "Adding…" : picks.length > 1 ? `Add ${picks.length} projects` : folder ? `Add ${folder}` : "Add project";
  // Enter adds, unless a highlighted row takes it (its keydown is prevented).
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!disabled && !adding && (tab !== "folder" || picks.length)) void finish();
  };
  return (
    <form onSubmit={submit} className="flex min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2 ps-7 pe-12 pt-6 pb-5">
        <DialogTitle>Add project</DialogTitle>
        <DialogDescription>Clone a project, pick a folder on this computer, or start a new one.</DialogDescription>
      </div>
      <div className="flex h-add-project-body min-h-0 flex-col gap-4 px-7 pb-5">{body}</div>
      <div className="flex shrink-0 items-center gap-2 border-t border-divider pt-3.75 pe-6 pb-4 ps-7">
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{hint}</span>
        {/* shortcut: closed while adding, the add goes on and shows its project, but a failure then goes unsaid; toast it if that bites. */}
        <DialogClose render={<Button variant="ghost" size="sm" />}>{adding ? "Close" : "Cancel"}</DialogClose>
        <Button size="sm" type="submit" className="min-w-0 max-w-1/2" disabled={disabled || adding || (tab === "folder" && picks.length === 0)}>
          {adding && <Spinner className="animate-spin" />}
          <span className="truncate">{label}</span>
        </Button>
      </div>
    </form>
  );
}
