import { useEffect, useState, useSyncExternalStore } from "react";

import { ErrorLine } from "../components/error-line";
import { daemonRun, failure } from "../session/composer";
import { KeptText } from "./attachment-tab";

/** What a note with nothing written yet is called, by its tab and the New tab. */
export const UNTITLED_NOTE = "Untitled note";

// Each note's name as Rust last gave it, by `<owner>/<note>`, for its tab [D244].
const titles = new Map<string, string>();
const listeners = new Set<() => void>();
export function setNoteTitle(owner: string, note: string, title: string): void {
  titles.set(`${owner}/${note}`, title);
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener));
export const useNoteTitle = (owner: string, note: string) => useSyncExternalStore(subscribe, () => titles.get(`${owner}/${note}`)) || UNTITLED_NOTE;

/** A session's note, kept by Rust under its folder as Markdown, as the old app's page in a tab [D244]. */
export function NoteTab({ owner, note, active }: { owner: string; note: string; active: boolean }) {
  const [read, setRead] = useState<{ text: string } | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    void daemonRun(["note", owner, "read", note]).then((reply) => {
      if (!live) return;
      if (!reply.ok) return setRead({ error: failure(reply) });
      setNoteTitle(owner, note, reply.title);
      setRead({ text: reply.text });
    });
    return () => {
      live = false;
    };
  }, [owner, note]);
  if (read === null) return <div aria-busy className="flex-1" />;
  if ("error" in read) return <ErrorLine size="sm" error={read.error} className="m-auto" />;
  const save = (text: string) =>
    daemonRun(["note", owner, "write", note, text]).then((reply) => {
      if (reply.ok) setNoteTitle(owner, note, reply.title);
      return reply;
    });
  return <KeptText label="Note" text={read.text} active={active} save={save} placeholder={UNTITLED_NOTE} />;
}
