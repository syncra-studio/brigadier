// The parts approval and question cards share (the old app's action card, tool box, step counter, card keys).
import { type ComponentProps, Fragment, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject, useEffect, useEffectEvent, useRef, useState } from "react";

import { ArrowRight, ChevronRight, Pencil, X } from "../../icons";
import { Badge } from "../badge";
import { cx } from "../cx";
import { TooltipIconButton } from "../icon-button";

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
 * `enter` Enter is left alone; with `within` it answers only from inside that element (the focused card), and
 * neither key answers from inside another card.
 */
export function useCardKeys(enabled: boolean, keys: { enter?: () => void; escape: () => void }, within?: RefObject<HTMLElement | null>) {
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (inField(target)) return;
    // Focus in another card (a question on the rail while an approval waits): its keys are its own.
    const card = target?.closest("[data-slot=action-card]");
    if (within && card && card !== within.current) return;
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
    "group/action inline-flex h-control-sm shrink-0 cursor-pointer items-center gap-1 rounded-capsule border border-fill px-2 text-code leading-4.5 whitespace-nowrap select-none",
    "transition-all focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-disabled motion-safe:enabled:active:scale-press-button",
    variant === "primary" ? "bg-foreground text-composer enabled:hover:bg-action-primary-hover" : "bg-action-wash text-foreground enabled:hover:bg-fill",
    className,
  );
}

/** A card's buttons, pushed to the end; `leading` (an error) at the start. Narrow, they stack full width. */
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

/** A question card's header: a few words over the question (a round's title), the question, `aside` (the round's pager), then ✕. */
export function ActionCardQuestion({
  children,
  kind,
  aside,
  onDismiss,
  dismissLabel = "Dismiss",
}: {
  children: ReactNode;
  kind?: ReactNode;
  aside?: ReactNode;
  onDismiss: () => void;
  dismissLabel?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-2 ps-4 pe-3 pt-4 pb-2">
      <div role="alert" aria-atomic="true" className="flex min-w-0 flex-1 flex-col gap-1">
        {kind && (
          <p data-slot="action-card-kind" className="text-code leading-5 text-card-kind">
            {kind}
          </p>
        )}
        <ActionCardTitle>{children}</ActionCardTitle>
      </div>
      {aside}
      <TooltipIconButton tooltip={dismissLabel} size="icon-sm" className="-mt-0.5 shrink-0 text-toolbar-foreground" onClick={onDismiss}>
        <X />
      </TooltipIconButton>
    </div>
  );
}

/** An answer's 20px square: its number (empty for a lone answer), or a dot once picked. */
function Marker({ chosen, children }: { chosen?: boolean; children?: ReactNode }) {
  return (
    <span
      aria-hidden
      data-slot="action-marker"
      className={cx(
        "flex size-5 shrink-0 items-center justify-center self-start rounded-sm border text-xs leading-none font-medium select-none",
        chosen ? "border-foreground text-foreground" : "border-marker text-marker-foreground",
      )}
    >
      {chosen ? <span className="size-1.5 rounded-capsule bg-current" /> : children}
    </span>
  );
}

/**
 * A numbered answer: its square, label, "Recommended", a description, → while lit or hovered. Not a button,
 * which would block selecting its words: `onClick` picks it, by the pointer or by Enter or Space on the row.
 */
export function ActionOption({
  number,
  name,
  label,
  description,
  recommended,
  highlighted,
  chosen,
  disabled,
  className,
  onKeyDown,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  /** null: the card's only answer, its square left empty. */
  number: number | null;
  /** What it reads as to a screen reader. */
  name: string;
  label: ReactNode;
  description?: ReactNode;
  recommended?: boolean;
  highlighted: boolean;
  /** Picked and about to go, or marked. */
  chosen?: boolean;
  disabled?: boolean;
}) {
  const onKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    if (!disabled && !event.repeat) event.currentTarget.click();
  };
  return (
    <div
      tabIndex={0}
      data-slot="action-option"
      data-highlighted={highlighted || undefined}
      aria-label={name}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeys}
      className={cx(
        "group/option flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-surface px-2 py-1.5 text-start text-code focus-visible:focus-ring",
        "aria-disabled:cursor-not-allowed",
        highlighted ? "bg-fill-subtle" : "hover:bg-fill-subtle",
        className,
      )}
      {...props}
    >
      <Marker chosen={chosen}>{number}</Marker>
      <span className="flex min-w-0 flex-1 flex-col gap-y-0.5">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 font-medium wrap-anywhere">{label}</span>
          {recommended && <Badge variant="secondary">Recommended</Badge>}
        </span>
        {description && <span className="min-w-0 wrap-anywhere text-toolbar-foreground">{description}</span>}
      </span>
      <ArrowRight
        aria-hidden
        className={cx(
          "ms-auto size-icon-md shrink-0 text-toolbar-foreground",
          highlighted ? "opacity-100" : "opacity-0 group-hover/option:opacity-100 group-focus-visible/option:opacity-100",
        )}
      />
    </div>
  );
}

/** The last row: ✎ (under numbered answers), the field, then its button. Lit while it holds the highlight. */
export function ActionFreeText({
  field,
  highlighted,
  marker = true,
  className,
  children,
  ...props
}: Omit<ComponentProps<"div">, "children"> & { field: ReactNode; highlighted?: boolean; marker?: boolean; children?: ReactNode }) {
  return (
    <div
      role="presentation"
      className={cx(
        "flex min-h-8 w-full items-start gap-2 px-2 py-1.5 text-code",
        marker && "rounded-sheet transition-colors hover:bg-fill-subtle",
        highlighted && "bg-fill-subtle",
        className,
      )}
      {...props}
    >
      {marker && (
        <span aria-hidden className="flex size-5 shrink-0 items-center justify-center text-toolbar-foreground">
          <Pencil className="size-icon-sm" />
        </span>
      )}
      {field}
      {children && <div className="flex items-center gap-2 place-self-end">{children}</div>}
    </div>
  );
}

/** When one question card follows another its rows fade in 50ms apart (`row-stagger`); the first shows as is. */
export function staggered(on: boolean, index: number): { className?: string; "data-row"?: number } {
  return on ? { className: "row-stagger", "data-row": index } : {};
}
