import { useCallback, useEffect } from "react";

import { useHomeProject } from "../home/start";
import { daemonRun } from "../session/composer";
import { HOME } from "../shell/tab-store";

// What changed a note, so each other view of it reads it again: its tab, the notes column, the New tab [D922].
const listeners = new Set<(note: string, from: unknown) => void>();
const CHANGES = new Set(["write", "rename", "pin", "delete"]);

/** Calls `onChange` for each change to a note made by anyone but `self`. */
export function useNoteChanges(onChange: (note: string) => void, self?: unknown): void {
  useEffect(() => {
    const listener = (note: string, from: unknown) => from !== self && onChange(note);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, [onChange, self]);
}

/**
 * `note <owner> …`: a session's notes are its project's, Home's those of the project it shows, or none's for a chat
 * [D913 D921]. A change it makes is told to the other views, `self` (the caller) left out.
 */
export function useNoteRun(owner: string, self?: unknown): typeof daemonRun {
  const home = useHomeProject();
  const project = owner === HOME ? (home?.id ?? null) : null;
  return useCallback(
    (args: string[]) =>
      daemonRun(["note", owner, ...args, ...(project ? ["--project", project] : [])]).then((reply) => {
        if (reply.ok && CHANGES.has(args[0]!)) for (const listener of [...listeners]) listener(args[1]!, self);
        return reply;
      }),
    [owner, project, self],
  );
}
