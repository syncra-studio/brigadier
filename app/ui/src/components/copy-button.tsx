import { useEffect, useRef, useState } from "react";

import { Check, Copy } from "../icons";
import { TooltipIconButton, type TooltipIconButtonProps } from "./icon-button";
import { showToast } from "./toast";

/** Copies `text` from a menu, which has no button to show a check on: a toast says how it went. */
export function copyWithToast(text: string, what: string): void {
  navigator.clipboard.writeText(text).then(
    () => showToast(`Copied ${what}`),
    () => showToast(`Failed to copy ${what}`, { tone: "error" }),
  );
}

/**
 * Copies `text`, then shows a check and says `copiedTooltip` for `copiedDuration` ms. Any other button
 * prop passes through; `onClick` runs before the copy (to stop the click reaching a card, say).
 */
export function CopyButton({
  text,
  tooltip = "Copy",
  copiedTooltip = "Copied",
  copiedDuration = 3000,
  onClick,
  ...props
}: Omit<TooltipIconButtonProps, "tooltip" | "children"> & {
  text: string;
  tooltip?: string;
  copiedTooltip?: string;
  copiedDuration?: number;
}) {
  // null until first copied: the copy icon animates only coming back from the check, never as it first draws.
  const [copied, setCopied] = useState<boolean | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <TooltipIconButton
      {...props}
      tooltip={copied ? copiedTooltip : tooltip}
      onClick={(event) => {
        onClick?.(event);
        if (!text) return;
        // A failed write (no permission) leaves the copy icon: nothing was copied.
        navigator.clipboard.writeText(text).then(() => {
          clearTimeout(timer.current);
          setCopied(true);
          timer.current = setTimeout(() => setCopied(false), copiedDuration);
        }, () => {});
      }}
    >
      {copied ? <Check key="copied" className="animate-copied-in motion-reduce:animate-none" /> : <Copy key="copy" className={copied === false ? "animate-copy-in motion-reduce:animate-none" : undefined} />}
    </TooltipIconButton>
  );
}
