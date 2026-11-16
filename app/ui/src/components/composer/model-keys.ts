import { type KeyboardEvent, useEffect } from "react";

const PARTS = ["marks", "models", "effort"];

/**
 * The shelf's arrows [D84, D89]: Tab walks its parts (marks → chips → effort → Fast), each one stop that keeps the
 * chosen item, and the arrows move within a part (any arrow along the marks and chips, ↑ ↓ along the effort scale, which
 * picks as it moves, as radios do). Returns whether it moved.
 */
export function moveKeys(event: KeyboardEvent<HTMLElement>): boolean {
  const target = event.target as HTMLElement;
  const here = target.closest<HTMLElement>("[data-picker-part]");
  const name = here?.dataset["pickerPart"];
  if (!here || !name || !PARTS.includes(name)) return false;
  const back = event.key === "ArrowUp" || (event.key === "ArrowLeft" && name !== "effort");
  const forth = event.key === "ArrowDown" || (event.key === "ArrowRight" && name !== "effort");
  if (!back && !forth) return false;
  const items = [...here.querySelectorAll<HTMLElement>("[data-picker-item]:not(:disabled)")];
  const at = items.indexOf(target);
  const next = items[Math.min(Math.max(at + (forth ? 1 : -1), 0), items.length - 1)];
  event.preventDefault();
  if (!next || next === target) return true;
  next.focus();
  if (name === "effort") next.click();
  return true;
}

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
