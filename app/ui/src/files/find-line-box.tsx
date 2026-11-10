import type { RefObject } from "react";

import { TooltipIconButton } from "../components/icon-button";
import { ArrowDown, ArrowUp, Search, X } from "../icons";
import { PLAIN_FIELD } from "./field";

/** Matches marked at most; past that, finding says so. */
export const MAX_MATCHES = 10_000;

const INPUT = "w-48 min-w-0 cursor-text bg-transparent text-sm outline-none placeholder:text-muted-foreground";

/** A file's find box (⌘F: the query, which match of how many, previous and next) or its go-to-line box (⌃G) [D1002]. */
export function FindLineBox({
  finding,
  query,
  count,
  current,
  lines,
  inputRef,
  onQueryChange,
  onStep,
  onGoTo,
  onFindEscape,
  onGoEscape,
  onClose,
}: {
  finding: boolean;
  query: string;
  count: number;
  current: number;
  lines: number;
  inputRef: RefObject<HTMLInputElement | null>;
  onQueryChange: (value: string) => void;
  onStep: (by: 1 | -1) => void;
  onGoTo: (value: string) => void;
  onFindEscape: () => void;
  onGoEscape: () => void;
  onClose: () => void;
}) {
  return (
    <div
      data-slot="file-find"
      className="absolute end-4 top-2 z-10 flex h-control-lg items-center gap-1 rounded-surface border border-border bg-popover ps-2 pe-1 text-foreground shadow-overlay"
    >
      {finding ? (
        <>
          <Search className="size-icon-sm shrink-0 text-muted-foreground" />
          <input
            {...PLAIN_FIELD}
            ref={inputRef}
            // ⌘F opens it to type in at once.
            autoFocus
            value={query}
            placeholder="Find"
            aria-label="Find in file"
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onStep(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onFindEscape();
              }
            }}
            className={INPUT}
          />
          <span className="shrink-0 px-1 text-xs text-muted-foreground tabular-nums">
            {!query ? "" : count === 0 ? "No results" : `${current + 1} of ${count >= MAX_MATCHES ? `${MAX_MATCHES}+` : count}`}
          </span>
          <TooltipIconButton tooltip="Previous match" shortcut="⇧↵" size="icon-xs" disabled={!count} onClick={() => onStep(-1)}>
            <ArrowUp />
          </TooltipIconButton>
          <TooltipIconButton tooltip="Next match" shortcut="↵" size="icon-xs" disabled={!count} onClick={() => onStep(1)}>
            <ArrowDown />
          </TooltipIconButton>
        </>
      ) : (
        <input
          {...PLAIN_FIELD}
          // ⌃G opens it to type in at once.
          autoFocus
          inputMode="numeric"
          placeholder={`Go to line (1–${lines})`}
          aria-label="Go to line"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onGoTo(event.currentTarget.value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onGoEscape();
            }
          }}
          className={INPUT}
        />
      )}
      <TooltipIconButton tooltip="Close" shortcut="Esc" size="icon-xs" onClick={onClose}>
        <X />
      </TooltipIconButton>
    </div>
  );
}
