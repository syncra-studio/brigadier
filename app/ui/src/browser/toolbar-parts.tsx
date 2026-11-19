import { type ReactNode, type RefObject, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { cx } from "../components/cx";
import { Button } from "../components/button";
import { TooltipIconButton } from "../components/icon-button";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, Reload, Search, Spinner, X } from "../icons";
import { findInPage, findLabel, useBrowserFind } from "./find";
import { useTabs } from "../shell/tab-store";
import { ungroup } from "./give";
import { stopDriving, takeOver, useAgentLit, useAgentPillSlot } from "./overlay";
import { useDriverNames } from "./tab-icon";

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

/** Each session's bar the user closed with ×, by the first tab of its agents' groups then: a new drive shows it again. */
const closedBars = new Map<string, string>();
const barListeners = new Set<() => void>();
function closeBar(owner: string, first: string): void {
  closedBars.set(owner, first);
  for (const listener of barListeners) listener();
}
const subscribeBars = (listener: () => void) => (barListeners.add(listener), () => void barListeners.delete(listener));

/**
 * The bar under the toolbar of every Browser tab of session `owner` while an agent has tabs there, as Chrome's
 * '"Claude" started debugging this browser': from its first drive until no group of its is left, working or not.
 * Cancel takes every agent's tabs back, as Ungroup; × closes the bar for the session [D894 D909].
 */
export function AgentSessionBar({ owner }: { owner: string }) {
  const driven = useTabs(owner).tabs.filter((tab) => tab.kind === "browser" && tab.driver);
  const drivers = [...new Set(driven.map((tab) => tab.driver ?? ""))];
  const names = useDriverNames(drivers);
  const first = driven[0]?.id;
  const closed = useSyncExternalStore(subscribeBars, () => closedBars.get(owner) === first);
  if (!first || closed) return null;
  return (
    <Banner slot="browser-agent-bar" text={`${[...new Set(names)].map((name) => `"${name}"`).join(" and ")} started using this browser`} onDismiss={() => closeBar(owner, first)}>
      <Button size="sm" onClick={() => drivers.forEach((driver) => ungroup(owner, driver))}>
        Cancel
      </Button>
    </Banner>
  );
}

/**
 * The pill hanging from the page's top while an agent holds tab `id`, as Claude in Chrome's: who works here, and Stop.
 * The user's click on the page adds Take over, focused [D779 D902]. Drawn in the app's agent layer (overlay.ts), over
 * any site, so its colours are fixed (theme.css's .brigadier-agent-pill).
 */
export function AgentPill({ id, driver }: { id: string; driver: string }) {
  const slot = useAgentPillSlot(id);
  const lit = useAgentLit(id);
  const take = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (lit) take.current?.focus();
  }, [lit]);
  if (!slot) return null;
  return createPortal(
    <div role="status" data-slot="browser-agent-pill">
      <span aria-hidden>✳</span>
      <span className="min-w-0 truncate">{driver} is working here</span>
      {lit > 0 && (
        <button ref={take} type="button" onClick={() => takeOver(id)}>
          Take over
        </button>
      )}
      <button type="button" data-stop onClick={() => stopDriving(id)}>
        <span aria-hidden data-square />
        Stop
      </button>
    </div>,
    slot,
  );
}
