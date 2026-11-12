import { type KeyboardEvent, useEffect } from "react";

const rowsOf = (list: Element | null) => [...(list?.querySelectorAll<HTMLElement>("[role=option], [data-picker-older]") ?? [])];
const part = (root: Element, name: string) => root.querySelector<HTMLElement>(`[data-picker-part=${name}]`);
/** A footer row's chosen choice, else its first. */
export const focusChoice = (row: Element | null) =>
  (row?.querySelector<HTMLElement>("[aria-pressed=true]") ?? row?.querySelector<HTMLElement>("button"))?.focus();

/**
 * ↑ ↓ move through a list's rows and between the footer's rows, ← → between the agents, the models and the footer's
 * levels (Base UI moves within those); ↓ from the search goes to the models and ↑ from the first model back to it.
 * A letter typed anywhere but the search goes to the search.
 */
export function moveKeys(event: KeyboardEvent<HTMLDivElement>, search: HTMLInputElement | null, type: (key: string) => void) {
  const target = event.target as HTMLElement;
  const root = event.currentTarget;
  if (target === search) {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    rowsOf(part(root, "models"))[0]?.focus();
    return;
  }
  const here = target.closest<HTMLElement>("[data-picker-part]");
  const name = here?.dataset["pickerPart"];
  if (!here || !name) return;
  // Space stays the row's own press.
  if ((event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey) || event.key === "Backspace") {
    event.preventDefault();
    type(event.key);
    search?.focus();
    return;
  }
  const selected = (list: HTMLElement[]) => list.find((row) => row.getAttribute("aria-selected") === "true") ?? list[0];
  const toModels = () => selected(rowsOf(part(root, "models")))?.focus();
  const footer = name === "effort" || name === "speed";
  if (footer) {
    const effort = part(root, "effort");
    const hasLevels = Boolean(effort?.querySelector("button"));
    if (event.key === "ArrowUp") {
      if (name === "speed" && hasLevels) focusChoice(effort);
      else toModels();
    } else if (event.key === "ArrowDown" && name === "effort") focusChoice(part(root, "speed"));
    else return;
    event.preventDefault();
    return;
  }
  const all = rowsOf(here);
  const at = all.indexOf(target);
  if (event.key === "ArrowDown") all[Math.min(at + 1, all.length - 1)]?.focus();
  else if (event.key === "ArrowUp") (at <= 0 && name === "models" ? search : all[Math.max(at - 1, 0)])?.focus();
  else if (event.key === "ArrowRight" && name === "agents") toModels();
  else if (event.key === "ArrowRight") focusChoice(part(root, "effort"));
  else if (event.key === "ArrowLeft" && name === "models") selected(rowsOf(part(root, "agents")))?.focus();
  else return;
  event.preventDefault();
}

const TEXT_FIELD = "input, textarea, [contenteditable=true], [contenteditable='']";

/** Base UI keeps a popover open when focus goes back to the field it came from: typing there, or in any field outside the picker, closes it. */
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
