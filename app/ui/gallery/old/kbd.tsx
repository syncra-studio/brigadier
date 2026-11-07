import type { ComponentProps } from "react";

import { cx } from "../../src/components/cx";

const CHIP = "rounded-capsule border-transparent bg-current-wash px-1.5 font-sans text-xs leading-none text-current";
const KEY = cx(
  "rounded-xs border-kbd-border bg-fill px-1 font-mono text-2xs text-muted-foreground",
  // On a button, a chip tinted with the button's own text colour.
  "in-button:rounded-capsule in-button:border-transparent in-button:bg-current-wash in-button:font-sans in-button:text-xs in-button:leading-none in-button:text-current",
  // In a tooltip, a grey pill after the tip.
  "in-tooltip:rounded-capsule in-tooltip:border-transparent in-tooltip:bg-fill-hover in-tooltip:px-1.5 in-tooltip:font-sans in-tooltip:text-xs in-tooltip:text-foreground",
);

/**
 * A key hint. `key` (the default) is a small grey key in the mono face; `chip` a capsule tinted
 * with the text's own colour, in the label's font.
 */
export function Kbd({ className, variant = "key", ...props }: ComponentProps<"kbd"> & { variant?: "key" | "chip" }) {
  return (
    <kbd
      data-slot="kbd"
      className={cx(
        "pointer-events-none inline-flex h-4.5 w-fit min-w-4.5 items-center justify-center border select-none svg:size-icon-xs",
        variant === "chip" ? CHIP : KEY,
        className,
      )}
      {...props}
    />
  );
}
