import {
  type ComponentProps,
  createContext,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { cx } from "./cx";
import { createPeek, PEEK_EXIT_MS, type Peek, type PeekPhase, type PeekZone } from "./sidebar-peek";
import { TooltipProvider } from "./tooltip";

/*
 * The sidebar panel: expanded to its width, collapsed to a strip of icons, or fully hidden. It eases
 * between these on a spring (the content beside it moves with it) while its contents cross-fade; the
 * expanded contents keep their full width, revealed rather than squeezed. ⌘B (Ctrl elsewhere) toggles
 * it. Its edge drags to resize it; dragged below half its smallest width, it collapses. In a narrow
 * window it collapses by itself, and comes back once there is room. While `keepOpen` it stays expanded.
 *
 * It holds nothing: open, width and collapse come in, and changes go out (the app remembers them).
 *
 * Collapsed, it peeks: resting the pointer on anything marked `data-sidebar-peek-trigger` (the strip's
 * mark), or on the window's start edge while hidden, floats the expanded panel over the content until
 * the pointer leaves it (sidebar-peek.ts has the timing). It never takes focus; Escape, a click outside,
 * resizing the window or `navigationKey` changing put it away, and it doesn't open under a menu or dialog.
 */

export type SidebarCollapse = "strip" | "hidden";

type SidebarContextProps = {
  state: "expanded" | "collapsed";
  open: boolean;
  collapse: SidebarCollapse;
  hidden: boolean;
  setOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  resizing: boolean;
  setResizing: (resizing: boolean) => void;
  /** Called with the width the edge was dragged to, in CSS pixels. */
  onWidthChange: (width: number) => void;
  /** Whether it can collapse here (not while held open). */
  canToggle: boolean;
  /** The collapsed panel floating over the content: up, playing its exit, or not shown. */
  peek: PeekPhase;
};

const SidebarContext = createContext<SidebarContextProps | null>(null);

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (!context) throw new Error("useSidebar must be used within a SidebarProvider.");
  return context;
}

/** A theme length (rem) in CSS pixels. */
function tokenPx(name: string): number {
  const root = getComputedStyle(document.documentElement);
  return parseFloat(root.getPropertyValue(name)) * parseFloat(root.fontSize);
}

function subscribeResize(onChange: () => void) {
  addEventListener("resize", onChange);
  return () => removeEventListener("resize", onChange);
}
const isNarrow = () => innerWidth < tokenPx("--spacing-narrow-window");

/**
 * A menu, popover or dialog is in use (focus is in it): the peek neither opens nor closes under it. Focus,
 * not presence, so a popup merely shown (the gallery's held ones) doesn't count.
 */
function overlayOpen() {
  return document.activeElement?.closest('[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]') != null;
}

/** After the window is resized, the peek waits this long before it can open again. */
const RESIZE_SETTLE_MS = 300;

/** What a pointer event is over, for this sidebar's peek (its own trigger and panel, not another sidebar's). */
function peekZone(event: PointerEvent, own: Element | null): PeekZone {
  const target = event.target instanceof Element && own?.contains(event.target) ? event.target : null;
  if (target?.closest("[data-sidebar-peek-panel]")) return "panel";
  // Only a resting mouse: not a touch, not a drag passing by. A trigger out of use (inert) doesn't count.
  const trigger = target?.closest("[data-sidebar-peek-trigger]");
  if (event.pointerType === "mouse" && event.buttons === 0 && trigger && !trigger.closest("[inert]")) return "trigger";
  return "outside";
}

/** The peek's pointer and keyboard wiring. `blocked` says whether it may open now. */
function usePeek(
  wrapper: RefObject<HTMLDivElement | null>,
  blocked: () => boolean,
  open: boolean,
  navigationKey: string | undefined,
): PeekPhase {
  const [phase, setPhase] = useState<PeekPhase>("closed");
  const peek = useRef<Peek | null>(null);
  const isBlocked = useRef(blocked);
  useEffect(() => {
    isBlocked.current = blocked;
  }, [blocked]);

  useEffect(() => {
    const fine = matchMedia("(hover: hover) and (pointer: fine)");
    const still = matchMedia("(prefers-reduced-motion: reduce)");
    let resizedAt = -Infinity;
    const controller = createPeek({
      onChange: (next) => {
        // Put away while focus is inside, it hands focus to the sidebar toggle, not to nowhere.
        const card = wrapper.current?.querySelector("[data-sidebar-peek-panel]");
        if (next !== "open" && card?.contains(document.activeElement)) {
          document.querySelector<HTMLElement>("[data-slot=sidebar-toggle]")?.focus({ preventScroll: true });
        }
        setPhase(next);
      },
      canOpen: () => fine.matches && !isBlocked.current() && performance.now() - resizedAt > RESIZE_SETTLE_MS && !overlayOpen(),
      holdOpen: overlayOpen,
      exitMs: () => (still.matches ? 0 : PEEK_EXIT_MS),
    });
    peek.current = controller;
    const onPointer = (event: PointerEvent) => controller.point(peekZone(event, wrapper.current));
    const onLeave = () => controller.point("outside");
    const onPointerDown = (event: PointerEvent) => {
      if (controller.phase() !== "open" || overlayOpen()) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target && wrapper.current?.contains(target) && target.closest("[data-sidebar-peek-panel], [data-sidebar-peek-trigger]")) return;
      controller.dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // A menu or dialog takes its own Escape first.
      if (event.key !== "Escape" || event.defaultPrevented || overlayOpen()) return;
      if (controller.phase() === "open") controller.dismiss();
    };
    const onResize = () => {
      resizedAt = performance.now();
      controller.dismiss();
    };
    document.addEventListener("pointermove", onPointer, { passive: true });
    document.addEventListener("pointerover", onPointer, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    addEventListener("resize", onResize);
    return () => {
      controller.dispose();
      peek.current = null;
      document.removeEventListener("pointermove", onPointer);
      document.removeEventListener("pointerover", onPointer);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      removeEventListener("resize", onResize);
    };
  }, [wrapper]);

  // Opened for real, it is the panel itself again.
  useEffect(() => {
    if (open) peek.current?.reset();
  }, [open]);
  // Going anywhere else puts it away.
  const seenKey = useRef(navigationKey);
  useEffect(() => {
    if (seenKey.current === navigationKey) return;
    seenKey.current = navigationKey;
    peek.current?.dismiss();
  }, [navigationKey]);

  return open ? "closed" : phase;
}

export function SidebarProvider({
  open: wideOpen,
  onOpenChange,
  width,
  onWidthChange,
  collapse = "strip",
  keepOpen = false,
  navigationKey,
  className,
  children,
  ...props
}: Omit<ComponentProps<"div">, "onChange"> & {
  /** Expanded while the window has room: the app's remembered choice. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The width the edge was dragged to, in CSS pixels; null for the default. */
  width: number | null;
  onWidthChange: (width: number) => void;
  /** Collapsed to a strip of icons, or hidden. */
  collapse?: SidebarCollapse;
  keepOpen?: boolean;
  navigationKey?: string;
}) {
  // In a narrow window it collapses, and the toggle opens it only until the window changes again.
  const narrow = useSyncExternalStore(subscribeResize, isNarrow);
  const [narrowOpen, setNarrowOpen] = useState(false);
  const [seenNarrow, setSeenNarrow] = useState(narrow);
  if (seenNarrow !== narrow) {
    setSeenNarrow(narrow);
    setNarrowOpen(false);
  }
  const open = keepOpen || (narrow ? narrowOpen : wideOpen);
  const setOpen = useCallback(
    (next: boolean) => {
      if (keepOpen) return;
      if (narrow) setNarrowOpen(next);
      else onOpenChange(next);
    },
    [keepOpen, narrow, onOpenChange],
  );
  const toggleSidebar = useCallback(() => setOpen(!open), [setOpen, open]);
  const [resizing, setResizing] = useState(false);
  const peekBlocked = useCallback(() => open || resizing, [open, resizing]);
  const wrapper = useRef<HTMLDivElement>(null);
  const peek = usePeek(wrapper, peekBlocked, open, navigationKey);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return;
      // ⌘B only: ⇧⌘B is left for others.
      if (event.code !== "KeyB" || event.shiftKey) return;
      event.preventDefault();
      if (!event.repeat) toggleSidebar();
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [toggleSidebar]);

  const hidden = !open && collapse === "hidden";
  const state = open ? "expanded" : "collapsed";
  const context = useMemo<SidebarContextProps>(
    () => ({ state, open, collapse, hidden, setOpen, toggleSidebar, resizing, setResizing, onWidthChange, canToggle: !keepOpen, peek }),
    [state, open, collapse, hidden, setOpen, toggleSidebar, resizing, onWidthChange, keepOpen, peek],
  );

  return (
    <SidebarContext.Provider value={context}>
      <TooltipProvider delay={0}>
        <div
          ref={wrapper}
          data-slot="sidebar-wrapper"
          data-state={state}
          data-collapse={hidden ? "hidden" : "strip"}
          data-width={width ?? undefined}
          className={cx("group/sidebar-wrapper sidebar-width-source flex h-full w-full", className)}
          {...props}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  );
}

/**
 * The panel: its column's top (the titlebar strip) drags the window, the rest is the panel's own surface.
 * The expanded contents (`children`) and the strip's (`strip`) cross-fade in the same place; `foot` is
 * shared by both, below them. Collapsed, the expanded contents can peek beside the strip, or at the
 * window's start while hidden (with the foot too, since no strip shows it).
 */
export function SidebarPanel({
  strip,
  foot,
  className,
  children,
  ...props
}: ComponentProps<"div"> & { strip?: ReactNode; foot?: ReactNode }) {
  const { open, hidden, resizing, peek } = useSidebar();
  return (
    <div data-slot="sidebar-panel" data-state={open ? "expanded" : "collapsed"} className="relative flex h-full shrink-0">
      <div
        inert={hidden}
        data-resizing={resizing || undefined}
        className={cx("sidebar-motion h-full overflow-clip", open ? "sidebar-panel-width" : hidden ? "w-0" : "w-sidebar-strip")}
      >
        <div className="flex h-full flex-col">
          <div className="app-drag h-titlebar shrink-0" />
          <div data-sidebar="sidebar" className={cx("flex min-h-0 flex-1 flex-col rounded-s-surface bg-background text-foreground", className)} {...props}>
            <div className="relative min-h-0 flex-1">
              <div
                inert={!open}
                className={cx(
                  "sidebar-panel-width absolute inset-y-0 start-0 flex flex-col transition-opacity motion-reduce:transition-none",
                  open ? "opacity-100" : "opacity-0",
                )}
              >
                {children}
              </div>
              <div
                inert={open || hidden}
                className={cx(
                  "absolute inset-y-0 start-0 flex w-sidebar-strip flex-col transition-opacity motion-reduce:transition-none",
                  open || hidden ? "opacity-0" : "opacity-100",
                )}
              >
                {strip}
              </div>
            </div>
            {foot}
          </div>
        </div>
      </div>
      {open && <SidebarResizeHandle />}
      {peek !== "closed" && (
        <SidebarPeek closing={peek === "closing"} hidden={hidden} foot={hidden ? foot : null}>
          {children}
        </SidebarPeek>
      )}
      {/* Hidden, the window's start edge peeks it. */}
      {hidden && <div aria-hidden data-sidebar-peek-trigger className="fixed start-0 top-titlebar bottom-0 z-20 w-sidebar-peek-edge" />}
    </div>
  );
}

/** The grab area straddling the panel's edge: drag to resize, below half the smallest width to close. */
function SidebarResizeHandle() {
  const { setOpen, resizing, setResizing, onWidthChange } = useSidebar();
  const start = useRef<{ x: number; width: number } | null>(null);
  const latest = useRef<number | null>(null);

  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setResizing(false);
    if (latest.current !== null) onWidthChange(latest.current);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      data-resizing={resizing || undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const panel = event.currentTarget.parentElement?.firstElementChild;
        if (!panel) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, width: panel.getBoundingClientRect().width };
        latest.current = null;
        setResizing(true);
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
        const wanted = start.current.width + (event.clientX - start.current.x) * (rtl ? -1 : 1);
        const min = tokenPx("--spacing-sidebar-min");
        if (wanted < min / 2) {
          end(event);
          setOpen(false);
          return;
        }
        latest.current = Math.round(Math.min(Math.max(wanted, min), tokenPx("--spacing-sidebar-max")));
        // Follows the pointer without a render; the app gets the width when the drag ends.
        event.currentTarget.closest("[data-slot=sidebar-wrapper]")?.setAttribute("data-width", String(latest.current));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      className="group/resize absolute end-0 top-titlebar bottom-0 z-10 flex w-resize-handle translate-x-1/2 cursor-col-resize justify-center rtl:-translate-x-1/2"
    >
      <span className="w-px bg-input opacity-0 transition-opacity group-hover/resize:opacity-100 group-data-resizing/resize:opacity-100" />
    </div>
  );
}

/**
 * The collapsed panel peeking: its expanded contents over the content, which never moves for it, carried
 * on from the strip (or, hidden, on a card at the window's start). It floats in from the start and fades
 * back out (at once with Reduce Motion).
 */
function SidebarPeek({ closing, hidden, foot, children }: { closing: boolean; hidden: boolean; foot: ReactNode; children: ReactNode }) {
  const context = useSidebar();
  const expanded = useMemo<SidebarContextProps>(() => ({ ...context, open: true, state: "expanded" }), [context]);
  return (
    <SidebarContext.Provider value={expanded}>
      <div
        inert={closing}
        data-slot="sidebar-peek"
        data-sidebar-peek-panel
        className={cx(
          "sidebar-panel-width absolute top-titlebar bottom-0 z-40 flex flex-col overflow-hidden bg-background text-foreground shadow-overlay motion-reduce:animate-none",
          // Beside the strip it is the strip's own panel carried on: flush against it, its edge and shadow
          // on the far side only. Hidden, it is a card.
          hidden ? "start-0 rounded-surface ring-1 ring-border" : "peek-edge start-sidebar-strip rounded-e-surface border-e border-border",
          closing ? "pointer-events-none animate-peek-out" : "animate-peek-in",
        )}
      >
        <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
        {foot}
      </div>
    </SidebarContext.Provider>
  );
}
