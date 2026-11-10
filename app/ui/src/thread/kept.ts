import { useState } from "react";

// Open or closed, by key, kept while rows unmount as they scroll out of view.
// shortcut: module-wide and never cleared, keyed by item id alone; scope it per session and drop it with the session
// once real sessions arrive.
const kept = new Map<string, boolean>();

/** Sets a kept state from outside its row (find folding back what it opened, the row maybe unmounted). */
export const setKept = (key: string, open: boolean) => kept.set(key, open);

export function useKept(key: string, initial = false): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => kept.get(key) ?? initial);
  return [
    open,
    (next) => {
      kept.set(key, next);
      setOpen(next);
    },
  ];
}
