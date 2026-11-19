import { useEffect, useRef, useState } from "react";

import { matches } from "../../shortcuts";
import { ComposerPill } from "./composer";
import { ModelLabel, ModelShelf, modelWords, type ShelfProps } from "./model-picker";
import { useClosesOnTyping } from "./model-keys";
import { RailItem } from "./rail";

/**
 * The composer's model picker, open or not [D83, D84]: the pill or ⌘. opens and folds it, as does `asked` going up (a
 * notice's "Choose another model"); Esc, Enter on a pick and a click or typing in the field fold it, a pick doesn't.
 * `present` stays true while it folds, so Home's project strip comes back after it.
 */
export function useModelStrip({ disabled, asked = 0 }: { disabled?: boolean; asked?: number }) {
  const [open, setOpen] = useState(false);
  const [present, setPresent] = useState(false);
  const [seen, setSeen] = useState(asked);
  const pill = useRef<HTMLButtonElement>(null);
  if (asked !== seen) {
    setSeen(asked);
    if (!disabled) setOpen(true);
  }
  if (open && disabled) setOpen(false);
  if (open && !present) setPresent(true);
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      // Only the composer on screen; offline or loading it doesn't open.
      if (!matches(event, "model") || !pill.current?.checkVisibility() || pill.current.disabled || pill.current.closest("[inert]")) return;
      event.preventDefault();
      setOpen((now) => !now);
    };
    window.addEventListener("keydown", press);
    return () => window.removeEventListener("keydown", press);
  }, []);
  // Folded by a key, the keyboard goes back to the field.
  const fold = (field: boolean) => {
    setOpen(false);
    if (field) pill.current?.closest("[data-slot=composer]")?.querySelector<HTMLElement>("[contenteditable=true]")?.focus();
  };
  useClosesOnTyping(open, () => setOpen(false));
  return { open, present, pill, toggle: () => setOpen((now) => !now), fold, gone: () => setPresent(false) };
}

export type ModelStripState = ReturnType<typeof useModelStrip>;

/** The model pill in the composer's footer: mark, model, ⚡ on Fast, effort; no chevron [D84]. */
export function ModelPill({ strip, groups, value, disabled }: { strip: ModelStripState; groups: ShelfProps["groups"]; value: ShelfProps["value"]; disabled?: boolean }) {
  return (
    <ComposerPill ref={strip.pill} aria-label={modelWords(groups, value)} aria-expanded={strip.open} data-slot="model-picker-trigger" disabled={disabled} onClick={strip.toggle}>
      <ModelLabel groups={groups} value={value} mark="size-icon-sm" />
    </ComposerPill>
  );
}

/** The shelf as the rail's last item, in the rail's own look, opening and folding as rail items do [D83, D85]. */
export function ModelStrip({ strip, ...shelf }: ShelfProps & { strip: ModelStripState }) {
  if (!strip.present) return null;
  return (
    <RailItem variant="model" label="Model" shown={strip.open} onGone={strip.gone}>
      <div className="px-1 pt-1.25 pb-1.25">
        <ModelShelf {...shelf} onEnter={() => strip.fold(true)} onEscape={() => strip.fold(true)} onLeave={() => strip.fold(false)} />
      </div>
    </RailItem>
  );
}
