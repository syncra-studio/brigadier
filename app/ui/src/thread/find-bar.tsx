import type { KeyboardEvent, RefObject } from "react";

import { TooltipIconButton } from "../components/icon-button";
import { ChevronLeft, ChevronRight, X } from "../icons";
import { Search } from "../icons/tab";

/** Proposed: what the count says while the rows not loaded can't be counted (find.tsx). */
const OLDER = { searching: "Searching older…", offline: "Offline: older not searched", failed: "Older not searched" } as const;

/**
 * Find in the conversation's bar, the old app's [D48, D470]: 24rem at most 70% of the window, over the thread's top
 * right; the field, the count, ‹ › and ✕. Enter and ⇧Enter step; Esc closes from the field or a button and goes no
 * further (the composer's Esc Esc stops a reply).
 */
export function FindBar({
  bar,
  input,
  query,
  label,
  older,
  none,
  onQuery,
  onStep,
  onClose,
}: {
  bar?: RefObject<HTMLDivElement | null>;
  input?: RefObject<HTMLInputElement | null>;
  query: string;
  /** "2 / 7 results"; null while the field is empty. */
  label: string | null;
  older: keyof typeof OLDER | null;
  none: boolean;
  onQuery: (text: string) => void;
  onStep: (by: 1 | -1) => void;
  onClose: () => void;
}) {
  const onEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  return (
    <div
      ref={bar}
      role="search"
      aria-label="Find in chat"
      className="absolute top-2 right-4 z-30 flex h-find-row w-thread-find max-w-thread-find-max min-w-0 items-center gap-2 rounded-overlay bg-popover ps-4 pe-2 text-foreground shadow-find"
    >
      <Search className="size-icon-md shrink-0 text-muted-foreground" />
      <input
        ref={input}
        value={query}
        placeholder="Search chat…"
        aria-label="Find in chat"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onStep(event.shiftKey ? -1 : 1);
          } else onEscape(event);
        }}
        className="h-6 min-w-0 flex-1 bg-transparent text-label outline-none placeholder:text-muted-foreground"
      />
      {label !== null && (
        <span aria-live="polite" className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums select-none">
          {label}
          {older && <span className="ms-1.5">· {OLDER[older]}</span>}
        </span>
      )}
      <TooltipIconButton tooltip="Previous result" shortcut="⇧↵" size="icon-xs" onKeyDown={onEscape} disabled={none} onClick={() => onStep(-1)}>
        <ChevronLeft />
      </TooltipIconButton>
      <TooltipIconButton tooltip="Next result" shortcut="↵" size="icon-xs" onKeyDown={onEscape} disabled={none} onClick={() => onStep(1)}>
        <ChevronRight />
      </TooltipIconButton>
      <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
      <TooltipIconButton tooltip="Close find" size="icon-xs" onKeyDown={onEscape} onClick={onClose}>
        <X />
      </TooltipIconButton>
    </div>
  );
}
