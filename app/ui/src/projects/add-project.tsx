import { type FormEvent, useEffect } from "react";

import { Button } from "../components/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../components/dialog";
import { Spinner } from "../icons";
import { run } from "../onboarding/api";
import { HERE } from "../onboarding/parts";
import { useProjectSources } from "../onboarding/sources";
import { useDaemon } from "../daemon";
import { closeAddProject, daemonSource, showProject, type Source, useAddProject } from "./store";

/*
 * Add project as onboarding's Projects step [D668, D676]: the same sources, several at a time across them, with Cancel.
 * ⌘O's folder comes in picked; a project already added shows itself instead.
 */

export { shortPath } from "../onboarding/sources";

/** Mounted once; opened by `openAddProject` from anywhere. `offline` while the daemon is away. */
export function AddProjectDialog({ source, offline }: { source: Source; offline: boolean }) {
  const { open, path, opening } = useAddProject();
  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeAddProject()}>
      <DialogContent frame="project-dialog max-w-wide-dialog gap-0 p-0">{open && <AddProject key={opening} source={source} offline={offline} initialPath={path} />}</DialogContent>
    </Dialog>
  );
}

/** The app's Add project, on the daemon. */
export function AddProjectHost() {
  const { daemon } = useDaemon();
  const pid = daemon?.pid;
  // Each daemon reads its lists once it's up, so the first open shows them at once, as onboarding's do [D678, D627].
  useEffect(() => {
    if (pid) run(["projects", "warm"]).catch(() => {});
  }, [pid]);
  return <AddProjectDialog source={daemonSource} offline={daemon === null} />;
}

const VERB = { folder: "Add", clone: "Clone", new: "Create" };

const shown = (id: string | undefined) => {
  closeAddProject();
  if (id) showProject(id);
};

export function AddProject({ source, offline, initialPath = "" }: { source: Source; offline: boolean; initialPath?: string }) {
  const { body, total, single, hint, adding, cloning, disabled, finish } = useProjectSources({ source, offline, initialPath, onExisting: shown, onDone: (ids) => shown(ids[0]) });
  const label = adding ? (cloning ? "Cloning…" : "Adding…") : total > 1 ? `Add ${total} projects` : single ? `${VERB[single.kind]} ${single.name}` : "Add project";
  // Enter adds, unless a highlighted row takes it (its keydown is prevented).
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!disabled && !adding && total) void finish();
  };
  return (
    <form onSubmit={submit} className="flex min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2 ps-7 pe-12 pt-6 pb-5">
        <DialogTitle>Add project</DialogTitle>
        <DialogDescription>Pick from {HERE} or any of your GitHub accounts; picks add up across them.</DialogDescription>
      </div>
      <div className="flex h-add-project-body min-h-0 flex-col px-7 pb-5">{body}</div>
      <div className="flex shrink-0 items-center gap-2 border-t border-divider pt-3.75 pe-6 pb-4 ps-7">
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{hint}</span>
        {/* shortcut: closed while adding, the add goes on and shows its project, but a failure then goes unsaid; toast it if that bites. */}
        <DialogClose render={<Button variant="ghost" size="sm" />}>{adding ? "Close" : "Cancel"}</DialogClose>
        <Button size="sm" type="submit" className="min-w-0 max-w-1/2" disabled={disabled || adding || total === 0}>
          {adding && <Spinner className="animate-spin" />}
          <span className="truncate">{label}</span>
        </Button>
      </div>
    </form>
  );
}
