import { useEffect, useState } from "react";

import { FolderPlus } from "../icons";
import { daemonSource, openFolders } from "../projects/store";

/** Where a drop isn't a project's: the composer, whose drop is its own [D2018]. */
const OWN_DROP = "[data-slot=composer]";

const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;
const elsewhere = (event: DragEvent) => !(event.target instanceof Element && event.target.closest(OWN_DROP));

/**
 * Folders dropped anywhere on the window but the composer become projects, through the path ⌘O takes: a repository is
 * added, a known project opens, and any other folder opens Add project [D165, D2018, D2022]. While something is dragged
 * over the window, the old app's veil says so.
 */
export function FolderDrop() {
  const [over, setOver] = useState(false);
  useEffect(() => {
    const hover = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      const ours = elsewhere(event);
      setOver(ours);
      if (!ours) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
    };
    // Off the window's edge, nothing is under the drag any more.
    const leave = (event: DragEvent) => event.relatedTarget === null && setOver(false);
    const drop = (event: DragEvent) => {
      setOver(false);
      if (!carriesFiles(event) || !elsewhere(event)) return;
      event.preventDefault();
      const paths = [...event.dataTransfer!.files].map((file) => window.brigadier?.pathForFile(file) ?? "").filter(Boolean);
      if (paths.length > 0) void openFolders(daemonSource, paths);
    };
    window.addEventListener("dragover", hover);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", hover);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  if (!over) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-popup flex items-center justify-center bg-background/70 p-6 backdrop-blur-sm">
      <div className="flex size-full flex-col items-center justify-center gap-3 rounded-surface border-2 border-dashed border-foreground/25 text-center">
        <FolderPlus className="size-10 text-muted-foreground" />
        <p className="text-lg font-medium">Drop folders to add them as projects</p>
        <p className="text-sm text-muted-foreground">A repository is added right away. A folder that's already a project opens.</p>
      </div>
    </div>
  );
}
