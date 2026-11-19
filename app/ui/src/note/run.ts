import { useCallback } from "react";

import { useHomeProject } from "../home/start";
import { daemonRun } from "../session/composer";
import { HOME } from "../shell/tab-store";

/** `note <owner> …`: a session's notes are its project's, Home's those of the project it shows, or none's for a chat [D913 D921]. */
export function useNoteRun(owner: string): typeof daemonRun {
  const home = useHomeProject();
  const project = owner === HOME ? (home?.id ?? null) : null;
  return useCallback((args: string[]) => daemonRun(["note", owner, ...args, ...(project ? ["--project", project] : [])]), [owner, project]);
}
