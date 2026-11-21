import { type ComponentProps, createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { matches } from "../shortcuts";
import { cx } from "./cx";
import { px, ResizeHandle } from "./resize-handle";
import { TooltipProvider } from "./tooltip";

/*
 * The sidebar panel at the window's start, our three modes [D226]: expanded, folded to the strip, or hidden. It eases
 * between them (the content beside it moves with it) while the sidebar's and the strip's contents crossfade, each kept
 * at its own width, revealed rather than squeezed. ⌘B (Ctrl elsewhere) and the toggle step expanded → strip → hidden →
 * expanded; the expanded edge drags to resize it, and dragged past half its least width it folds to the strip [D21]. In a
 * narrow window it folds to the strip by itself, until the window changes again [D68]. While `keepOpen` it stays expanded.
 *
 * It holds nothing: the mode and the width come in, and changes go out (the app remembers them).
 */

export type SidebarMode = "expanded" | "strip" | "hidden";
const NEXT: Record<SidebarMode, SidebarMode> = { expanded: "strip", strip: "hidden", hidden: "expanded" };

type SidebarContextProps = {
  mode: SidebarMode;
  /** Expanded. */
  open: boolean;
  setMode: (mode: SidebarMode) => void;
  toggleSidebar: () => void;
  /** Whether it can hide here (not while held open). */
  canToggle: boolean;
  onWidthChange: (width: number) => void;
};

const SidebarContext = createContext<SidebarContextProps | null>(null);

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (!context) throw new Error("useSidebar must be used within a SidebarProvider.");
  return context;
}

function subscribeResize(onChange: () => void) {
  addEventListener("resize", onChange);
  return () => removeEventListener("resize", onChange);
}
const isNarrow = () => innerWidth < px("--spacing-narrow-window");

export function SidebarProvider({
  mode: wideMode,
  onModeChange,
  width = null,
  onWidthChange = () => {},
  keepOpen = false,
  className,
  children,
  ...props
}: Omit<ComponentProps<"div">, "onChange"> & {
  /** Its mode while the window has room: the app's remembered choice. */
  mode: SidebarMode;
  onModeChange: (mode: SidebarMode) => void;
  /** Where it was dragged to, or null for the default. */
  width?: number | null;
  onWidthChange?: (width: number) => void;
  keepOpen?: boolean;
}) {
  // In a narrow window it folds to the strip, and the toggle steps on from there only until the window changes again.
  const narrow = useSyncExternalStore(subscribeResize, isNarrow);
  const [narrowMode, setNarrowMode] = useState<SidebarMode>("strip");
  const [seenNarrow, setSeenNarrow] = useState(narrow);
  if (seenNarrow !== narrow) {
    setSeenNarrow(narrow);
    setNarrowMode("strip");
  }
  const mode = keepOpen ? "expanded" : narrow ? narrowMode : wideMode;
  const open = mode === "expanded";
  const setMode = useCallback(
    (next: SidebarMode) => {
      if (keepOpen) return;
      if (narrow) setNarrowMode(next);
      else onModeChange(next);
    },
    [keepOpen, narrow, onModeChange],
  );
  // Every path (the titlebar toggle, ⌘B, View › Toggle Sidebar) steps to the next mode [D226].
  const toggleSidebar = useCallback(() => setMode(NEXT[mode]), [mode, setMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matches(event, "sidebar")) return;
      event.preventDefault();
      if (!event.repeat) toggleSidebar();
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [toggleSidebar]);

  const context = useMemo<SidebarContextProps>(
    () => ({ mode, open, setMode, toggleSidebar, canToggle: !keepOpen, onWidthChange }),
    [mode, open, setMode, toggleSidebar, keepOpen, onWidthChange],
  );

  return (
    <SidebarContext.Provider value={context}>
      <TooltipProvider delay={0}>
        <div
          data-slot="sidebar-wrapper"
          data-state={open ? "expanded" : "collapsed"}
          data-mode={mode}
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

/** The sidebar's contents and the strip (`rail`) in one column at the window's start, under the titlebar row [D69 D226]. */
export function SidebarPanel({ rail, className, children, ...props }: ComponentProps<"div"> & { rail?: ReactNode }) {
  const { mode, open, setMode, onWidthChange } = useSidebar();
  const [resizing, setResizing] = useState(false);
  const fade = "absolute inset-y-0 start-0 flex transition-opacity duration-200 motion-reduce:transition-none";
  return (
    <div data-slot="sidebar-panel" data-state={open ? "expanded" : "collapsed"} className="relative flex h-full shrink-0">
      {/* Its room, eased: the sidebar's width, the strip's, or none. Still while dragged, but folding mid-drag it eases. */}
      <div data-resizing={(resizing && open) || undefined} className={cx("sidebar-motion relative h-full overflow-clip", open ? "sidebar-panel-width" : mode === "strip" ? "w-rail" : "w-0")}>
        <div inert={!open} className={cx(fade, !open && "opacity-0")}>
          <div data-sidebar="sidebar" className={cx("sidebar-panel-width relative flex h-full flex-col pt-tab-bar text-foreground", className)} {...props}>
            {children}
          </div>
        </div>
        <div inert={mode !== "strip"} className={cx(fade, mode !== "strip" && "opacity-0")}>
          {rail}
        </div>
      </div>
      {(open || resizing) && (
        <ResizeHandle
          end
          label="Resize sidebar"
          min="--spacing-left-sidebar-min"
          max="--spacing-left-sidebar-max"
          holder={(handle) => handle.closest('[data-slot="sidebar-wrapper"]')}
          resizing={resizing}
          setResizing={setResizing}
          onWidth={onWidthChange}
          onClose={() => setMode("strip")}
          onOpen={() => setMode("expanded")}
        />
      )}
    </div>
  );
}
