import { type ComponentProps, createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { matches } from "../shortcuts";
import { cx } from "./cx";
import { px, ResizeHandle } from "./resize-handle";
import { TooltipProvider } from "./tooltip";

/*
 * The sidebar panel: the strip always at the window's start and the sidebar beside it, shown or hidden
 * [D11 D67]. It eases between the two (the content beside it moves with it), its contents kept at their full width,
 * revealed rather than squeezed. ⌘B (Ctrl elsewhere) toggles it; its edge drags to resize it, and dragged past its
 * least width it hides [D21]. In a narrow window it hides by itself, and comes back once there is room [D68]. While
 * `keepOpen` it stays shown.
 *
 * It holds nothing: open and the width come in, and changes go out (the app remembers them).
 */

type SidebarContextProps = {
  open: boolean;
  setOpen: (open: boolean) => void;
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
  open: wideOpen,
  onOpenChange,
  width = null,
  onWidthChange = () => {},
  keepOpen = false,
  className,
  children,
  ...props
}: Omit<ComponentProps<"div">, "onChange"> & {
  /** Shown while the window has room: the app's remembered choice. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where it was dragged to, or null for the default. */
  width?: number | null;
  onWidthChange?: (width: number) => void;
  keepOpen?: boolean;
}) {
  // In a narrow window it hides, and the toggle shows it only until the window changes again.
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
  // Every path (the titlebar toggle, ⌘B, View › Toggle Sidebar) shows or hides it [D67].
  const toggleSidebar = useCallback(() => setOpen(!open), [open, setOpen]);

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
    () => ({ open, setOpen, toggleSidebar, canToggle: !keepOpen, onWidthChange }),
    [open, setOpen, toggleSidebar, keepOpen, onWidthChange],
  );

  return (
    <SidebarContext.Provider value={context}>
      <TooltipProvider delay={0}>
        <div
          data-slot="sidebar-wrapper"
          data-state={open ? "expanded" : "collapsed"}
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

/** The strip (`rail`) and, beside it, the sidebar's contents, flush at the window's start under the titlebar row [D69]. */
export function SidebarPanel({ rail, className, children, ...props }: ComponentProps<"div"> & { rail?: ReactNode }) {
  const { open, setOpen, onWidthChange } = useSidebar();
  const [resizing, setResizing] = useState(false);
  return (
    <div data-slot="sidebar-panel" data-state={open ? "expanded" : "collapsed"} className="relative flex h-full shrink-0">
      {rail}
      <div inert={!open} data-resizing={resizing || undefined} className={cx("sidebar-motion h-full overflow-clip", open ? "sidebar-panel-width" : "w-0")}>
        <div data-sidebar="sidebar" className={cx("sidebar-panel-width relative flex h-full flex-col pt-tab-bar text-foreground", className)} {...props}>
          {children}
        </div>
      </div>
      {open && (
        <ResizeHandle
          end
          label="Resize sidebar"
          min="--spacing-left-sidebar-min"
          max="--spacing-left-sidebar-max"
          holder={(handle) => handle.closest('[data-slot="sidebar-wrapper"]')}
          resizing={resizing}
          setResizing={setResizing}
          onWidth={onWidthChange}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
