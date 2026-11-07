import type { ReactNode } from "react";

import { X } from "../icons";
import { cx } from "./cx";
import { TooltipIconButton } from "./icon-button";

/** A strip across the top of a pane: what happened, and what to do about it. */
export function Banner({
  tone = "info",
  text,
  children,
  onDismiss,
  className,
}: {
  /** `error` is red and announced at once; `info` and `warning` sit on a light wash. */
  tone?: "info" | "warning" | "error";
  text: ReactNode;
  /** Its buttons, after the words. */
  children?: ReactNode;
  /** Shows a × that calls it. */
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <div
      data-slot="banner"
      role={tone === "error" ? "alert" : "status"}
      data-tone={tone}
      className={cx(
        "flex shrink-0 items-center gap-2 border-b px-4 py-2 text-sm",
        tone === "error" ? "border-destructive-line bg-destructive-wash text-destructive" : "border-border bg-fill-subtle",
        className,
      )}
    >
      {/* Words and buttons wrap as one; the × keeps to the first line's end. */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <span data-slot="banner-text" className="min-w-0 flex-1 basis-48 wrap-break-word">
          {text}
        </span>
        {children}
      </div>
      {onDismiss && (
        <TooltipIconButton tooltip="Dismiss" size="icon-xs" onClick={onDismiss}>
          <X />
        </TooltipIconButton>
      )}
    </div>
  );
}
