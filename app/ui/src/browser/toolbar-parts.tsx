import { type ReactNode, type RefObject, useEffect, useRef } from "react";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, Reload, Search, Spinner, X } from "../icons";
import { findInPage, findLabel, useBrowserFind } from "./find";
import { stopDriving, takeOver, useAgentDoing, useAgentHoldsAny, useAgentLit } from "./overlay";

/** Back, Forward and Reload: round, and faint while they can't act (the button's own disabled look). */
const NAV_BUTTON = "rounded-capsule";

export type NavAction = "back" | "forward" | "reload" | "stop";

/** The browser toolbar's Back, Forward and Reload (Stop while the page loads), in one capsule. */
export function NavigationCapsule({ disabled, canGoBack, canGoForward, loading, onAct }: {
  disabled: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  onAct: (action: NavAction) => void;
}) {
  return (
    <div inert={disabled} data-gone={disabled || undefined} className={cx("makes-way flex shrink-0", disabled ? "-me-1.5 w-0" : "w-auto")}>
      <div role="group" aria-label="Navigation" data-slot="browser-navigation" className="flex h-control-md shrink-0 items-center rounded-capsule bg-control p-0.5 ring-1 ring-glass-stroke ring-inset">
        <TooltipIconButton tooltip="Back" size="icon-md" className={NAV_BUTTON} disabled={disabled || !canGoBack} onClick={() => onAct("back")}>
          <ArrowLeft />
        </TooltipIconButton>
        <TooltipIconButton tooltip="Forward" size="icon-md" className={NAV_BUTTON} disabled={disabled || !canGoForward} onClick={() => onAct("forward")}>
          <ArrowRight />
        </TooltipIconButton>
        <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
        {/* While the page loads the spinner stands in for Reload, and stops the load. */}
        <TooltipIconButton
          tooltip={loading ? "Stop loading" : "Reload"}
          size="icon-md"
          className={NAV_BUTTON}
          aria-busy={loading}
          disabled={disabled}
          onClick={() => onAct(loading ? "stop" : "reload")}
        >
          {loading ? <Spinner className="animate-spin" /> : <Reload />}
        </TooltipIconButton>
      </div>
    </div>
  );
}

/**
 * The page's find bar, under the toolbar at its end: the text, which match of how many, the
 * previous and next match, and close. Enter goes to the next match, Shift+Enter the previous,
 * Esc closes.
 */
export function FindBar({ id, input, onClose }: { id: string; input: RefObject<HTMLInputElement | null>; onClose: () => void }) {
  const find = useBrowserFind(id);
  const label = findLabel(find);
  const step = (backwards: boolean) => {
    if (find.query) void findInPage(id, find.query, backwards ? "previous" : "next");
  };
  return (
    <div data-slot="browser-find-row" className="flex shrink-0 justify-end border-b border-border px-2 py-1">
      <div
        role="search"
        aria-label="Find in page"
        data-slot="browser-find"
        className="flex h-find-row w-browser-find max-w-full min-w-0 items-center gap-2 rounded-overlay bg-popover ps-4 pe-2 text-foreground shadow-find"
      >
        <Search aria-hidden className="size-icon-md shrink-0 text-muted-foreground" />
        <input
          ref={input}
          value={find.query}
          placeholder="Find in page…"
          aria-label="Find in page"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          onChange={(event) => void findInPage(id, event.target.value, "type")}
          onFocus={(event) => event.target.select()}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              step(event.shiftKey);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
          className="h-6 min-w-0 flex-1 bg-transparent text-label outline-none placeholder:text-muted-foreground"
        />
        <span data-slot="browser-find-count" aria-live="polite" className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums select-none">
          {label}
        </span>
        <TooltipIconButton tooltip="Previous match" shortcut="⇧↵" size="icon-xs" disabled={!find.found} onClick={() => step(true)}>
          <ChevronUp />
        </TooltipIconButton>
        <TooltipIconButton tooltip="Next match" shortcut="↵" size="icon-xs" disabled={!find.found} onClick={() => step(false)}>
          <ChevronDown />
        </TooltipIconButton>
        <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
        <TooltipIconButton tooltip="Close find" size="icon-xs" onClick={onClose}>
          <X />
        </TooltipIconButton>
      </div>
    </div>
  );
}

/** A strip across the top of the tab's page: what happened, and what to do about it (the old shared Banner). */
export function Banner({ text, children, onDismiss, slot }: { text: ReactNode; children?: ReactNode; onDismiss?: () => void; slot?: string }) {
  return (
    <div role="status" data-slot={slot ?? "banner"} className="flex shrink-0 items-center gap-2 border-b border-border bg-fill-subtle px-4 py-2 text-sm">
      {/* Words and buttons wrap as one; the × keeps to the first line's end. */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 basis-48 wrap-break-word">{text}</span>
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

/**
 * The slim notice under the toolbar while an agent drives tab `id`, as Chrome's "started debugging this browser" bar:
 * who drives and what it does, with Take over and Stop. The user's click on the page lights Take over [D779 D794].
 */
export function DrivingBar({ id, driver }: { id: string; driver: string }) {
  const holds = useAgentHoldsAny([id]);
  const doing = useAgentDoing(id);
  const lit = useAgentLit(id);
  const take = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (lit) take.current?.focus();
  }, [lit]);
  if (!holds) return null;
  return (
    <div role="status" data-slot="browser-driving" className="flex shrink-0 items-center justify-center gap-2 border-b border-border bg-fill-subtle px-4 py-1 text-sm text-muted-foreground">
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">{driver}</span> is using this tab{doing && ` · ${doing}`}
      </span>
      <Button ref={take} size="xs" variant={lit ? "default" : "outline"} onClick={() => takeOver(id)}>
        Take over
      </Button>
      <Button size="xs" variant="soft-destructive" onClick={() => stopDriving(id)}>
        Stop
      </Button>
    </div>
  );
}
