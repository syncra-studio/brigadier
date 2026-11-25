import { useEffect, useRef } from "react";

import { matches } from "../../shortcuts";
import { ComposerPill } from "./composer";
import { ModelPicker, modelWords, type PickerProps } from "./model-picker";

/**
 * The model pill in the composer's footer: mark, model, ⚡ on Fast, effort; no chevron [D84]. It or ⌘. opens and closes
 * the menu over it, as does `asked` going up; the keyboard then goes back to the field.
 */
export function ModelPill({ disabled, asked, ...picker }: PickerProps & { disabled?: boolean; asked?: number }) {
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      const pill = box.current?.querySelector("button");
      // Only the composer on screen; offline or loading it doesn't open.
      if (!matches(event, "model") || !pill?.checkVisibility() || pill.disabled || pill.closest("[inert]")) return;
      event.preventDefault();
      pill.click();
    };
    window.addEventListener("keydown", press);
    return () => window.removeEventListener("keydown", press);
  }, []);
  return (
    <span ref={box} className="contents">
      <ModelPicker
        {...picker}
        disabled={disabled}
        asked={asked}
        side="top"
        align="end"
        finalFocus={() => box.current?.closest("[data-slot=composer]")?.querySelector<HTMLElement>("[contenteditable=true]") ?? true}
        trigger={({ children, ...props }) => (
          <ComposerPill {...props} aria-label={modelWords(picker.groups, picker.value)} data-slot="model-picker-trigger">
            {children}
          </ComposerPill>
        )}
      />
    </span>
  );
}
