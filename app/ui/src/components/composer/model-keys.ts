import { useEffect } from "react";

const TEXT_FIELD = "input, textarea, [contenteditable=true], [contenteditable='']";

/** Clicking or typing in a field outside the picker (the composer's own) closes it. */
export function useClosesOnTyping(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const typing = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.matches(TEXT_FIELD) && !event.target.closest("[data-slot=model-picker]")) close();
    };
    document.addEventListener("focusin", typing, true);
    return () => document.removeEventListener("focusin", typing, true);
  }, [open]);
}

const NAMES = new Map<string, string>();
/** A model's name by any list the picker had: one still loading (a new project's) never shows its raw id. */
export function named(groups: readonly { provider: string; models: readonly { id: string; name: string }[] }[], provider: string, id: string): string {
  for (const group of groups) for (const each of group.models) NAMES.set(`${group.provider}/${each.id}`, each.name);
  return NAMES.get(`${provider}/${id}`) ?? id;
}
