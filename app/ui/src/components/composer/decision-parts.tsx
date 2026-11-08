// The parts approval and question cards share (the old app's action card, tool box, step counter, card keys).
import { type ComponentProps, Fragment, type ReactNode, type RefObject, useEffect, useEffectEvent, useRef, useState } from "react";

import { ChevronRight, Reply } from "../../icons";
import { cx } from "../cx";

/**
 * A card's words with their backticked names as code; `exact` (a command, a tool's input) keeps the backticks
 * as written.
 * shortcut: web addresses stay plain text; draw them as links once the app opens links from cards.
 */
export function CodeSpans({ text, exact = false }: { text: string; exact?: boolean }) {
  return text
    .split(/`([^`\n]+)`/)
    .map((part, index) =>
      index % 2 === 0 || exact ? (
        <Fragment key={index}>{index % 2 === 0 ? part : `\`${part}\``}</Fragment>
      ) : (
        <code key={index} className="rounded-control bg-muted px-1 py-px font-mono text-code-inline">
          {part}
        </code>
      ),
    );
}

/** A field the user types in: its keys are its own, not the card's. */
const FIELD = "input, textarea, select, [contenteditable]:not([contenteditable='false' i])";
/** Open menus, dialogs and the field's own menus, which take Enter and Esc first (not the gallery's, held open). */
const OVERLAYS = ["[role=dialog]", "[role=menu]", "[role=listbox]", "[data-slot=composer-menu]"].map((open) => `${open}:not([data-held] *)`).join(", ");

export const inField = (target: EventTarget | null) => target instanceof Element && target.closest(FIELD) !== null;

/**
 * Esc and Enter for a card, from anywhere in the window: not from a text field (the composer sends), not Enter
 * on a focused button, answer row or link (that clicks it), and not while a menu or dialog is open. Without
 * `enter` Enter is left alone; with `within` it answers only from inside that element (the focused card).
 */
export function useCardKeys(enabled: boolean, keys: { enter?: () => void; escape: () => void }, within?: RefObject<HTMLElement | null>) {
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (inField(target)) return;
    if (event.key === "Enter") {
      if (!keys.enter) return;
      if (target?.closest("button, a[href], [role=button], [role=radio], [role=checkbox], summary")) return;
      if (within && !(target && within.current?.contains(target))) return;
    }
    if (document.querySelector(OVERLAYS)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Enter") keys.enter?.();
    else keys.escape();
  });
  useEffect(() => {
    if (!enabled) return;
    // Capture, so the card answers before the composer's Esc-to-stop sees the key.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabled]);
}

/**
 * "‹ 1 of 3 ›": bare arrows around "n of m". `noun` names the arrows ("Previous request").
 */
export function StepCounter({
  noun,
  at,
  count,
  onStep,
  canBack = true,
  canForward = true,
  className,
}: {
  noun: string;
  at: number;
  count: number;
  onStep: (step: -1 | 1) => void;
  canBack?: boolean;
  canForward?: boolean;
  className?: string;
}) {
  const arrow = "cursor-pointer rounded-control p-0.5 svg:size-icon-xs enabled:hover:text-foreground focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-disabled";
  return (
    <span data-slot="step-counter" className={cx("flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground tabular-nums", className)}>
      <button type="button" aria-label={`Previous ${noun}`} className={arrow} disabled={!canBack} onClick={() => onStep(-1)}>
        <ChevronRight className="rotate-180" />
      </button>
      <span className="whitespace-nowrap">
        {at + 1} of {count}
      </span>
      <button type="button" aria-label={`Next ${noun}`} className={arrow} disabled={!canForward} onClick={() => onStep(1)}>
        <ChevronRight />
      </button>
    </span>
  );
}

/**
 * A quiet box of exact text: a command a card asks about, a plan, a message. Mono unless `prose`. It scrolls
 * past 240px; `clamp` shows three lines until Expand.
 */
export function ToolBox({ prose = false, clamp = false, children }: { prose?: boolean; clamp?: boolean; children: ReactNode }) {
  const text = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  useEffect(() => {
    const element = text.current;
    if (!clamp || !element) return;
    const observer = new ResizeObserver(() => setClamped(element.scrollHeight > element.clientHeight + 1));
    observer.observe(element);
    return () => observer.disconnect();
  }, [clamp]);
  return (
    <div data-slot="tool-box" className="mx-3 flex flex-col rounded-control bg-code-surface text-tool-box-text">
      <div className="max-h-60 overflow-auto px-3 pt-2 pb-2">
        <div ref={text} className={cx("break-words whitespace-pre-wrap select-text", prose ? "text-sm" : "font-mono text-code", clamp && !expanded && "line-clamp-3")}>
          {children}
        </div>
      </div>
      {clamp && (clamped || expanded) && (
        <div className="flex shrink-0 justify-end p-1">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="cursor-pointer rounded-icon-button px-2 py-0.5 text-code leading-4.5 text-toolbar-foreground transition-colors hover:bg-fill focus-visible:focus-ring"
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
        </div>
      )}
    </div>
  );
}

/** Files a card asks about: the folder dim, the name bright, `trailing` at the end (a line count); scrolls. */
export function ActionFileList({ files }: { files: { path: string; trailing?: ReactNode }[] }) {
  return (
    <div className="px-4 py-2">
      <div className="flex max-h-50 flex-col overflow-y-auto rounded-icon-button border border-border bg-file-list">
        {files.map(({ path, trailing }) => {
          const slash = path.lastIndexOf("/");
          return (
            <div key={path} className="flex min-w-0 items-center gap-2.5 p-1.5 text-sm font-medium">
              <span title={path} className="flex min-w-0 flex-1 items-center">
                {slash > 0 && <span className="min-w-0 truncate text-toolbar-foreground">{path.slice(0, slash + 1)}</span>}
                <span className="max-w-full shrink-0 truncate">{path.slice(slash + 1)}</span>
              </span>
              {trailing}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The card itself. Every word on it can be selected and copied; its buttons can't. */
export function ActionCard({ className, container = "approval", ...props }: ComponentProps<"section"> & { container?: "approval" | "request" }) {
  return (
    <section
      data-slot="action-card"
      className={cx(
        container === "approval" ? "@container/approval-card" : "@container/request-card",
        "flex w-full flex-col text-foreground outline-none select-text",
        className,
      )}
      {...props}
    />
  );
}

/** The question the card asks, and a muted line under it. */
export function ActionCardTitle({ children, detail }: { children: ReactNode; detail?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <h2 className="min-w-0 text-sm leading-5 font-medium wrap-anywhere">{children}</h2>
      {detail && <p className="text-code text-toolbar-foreground">{detail}</p>}
    </div>
  );
}

/** A button's look on a card: a capsule, the primary filled, the other outlined. */
export function actionButton(variant: "primary" | "outline", className?: string): string {
  return cx(
    "group/action inline-flex h-control-sm shrink-0 cursor-pointer items-center gap-1 rounded-capsule border border-fill px-2 text-code leading-4.5 font-normal whitespace-nowrap select-none",
    "transition-all focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-disabled motion-safe:enabled:active:scale-press-button",
    variant === "primary" ? "bg-foreground text-composer enabled:hover:bg-action-primary-hover" : "bg-action-wash text-foreground enabled:hover:bg-fill",
    className,
  );
}

/** A card's buttons, pushed to the end; `leading` (Reply…, an error) at the start. Narrow, they stack full width. */
export function ActionCardActions({ leading, children }: { leading?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-4 pt-2 pb-4 @max-card-narrow/approval-card:flex-col @max-card-narrow/approval-card:items-stretch">
      {leading}
      <div className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-2 @max-card-narrow/approval-card:ms-0 @max-card-narrow/approval-card:w-full @max-card-narrow/approval-card:flex-col @max-card-narrow/approval-card:items-stretch">
        {children}
      </div>
    </div>
  );
}

/** An approval's "Reply…" in the composer's place: brings the message field back. */
export function ReplyButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-slot="approval-reply"
      onClick={onClick}
      className="inline-flex h-control-sm shrink-0 cursor-pointer items-center gap-1.5 rounded-capsule px-2 text-code text-reply transition-all hover:bg-fill hover:text-foreground focus-visible:focus-ring motion-safe:active:scale-press-button"
    >
      <Reply className="size-icon-sm" />
      Reply…
    </button>
  );
}
