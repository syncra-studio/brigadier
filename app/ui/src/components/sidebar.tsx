import { type ComponentProps, createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { matches } from "../shortcuts";
import { cx } from "./cx";
import { px, ResizeHandle } from "./resize-handle";
import { TooltipProvider } from "./tooltip";

/*
 * The sidebar panel at the window's start: shown, or folded to the strip [D226, demo A]. It eases between the two (the
 * content beside it moves with it) while the sidebar's and the strip's contents crossfade, each kept at its own width,
 * revealed rather than squeezed. ⌘B (Ctrl elsewhere) toggles it; its edge drags to resize it, and dragged past half its
 * least width it folds to the strip [D21]. In a narrow window it folds by itself, and comes back once there is room [D68].
 *
 * It holds nothing: open and the width come in, and changes go out (the app remembers them).
 */

type SidebarContextProps = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleSidebar: () => void;
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
}) {
  // In a narrow window it hides, and the toggle shows it only until the window changes again.
  const narrow = useSyncExternalStore(subscribeResize, isNarrow);
  const [narrowOpen, setNarrowOpen] = useState(false);
  const [seenNarrow, setSeenNarrow] = useState(narrow);
  if (seenNarrow !== narrow) {
    setSeenNarrow(narrow);
    setNarrowOpen(false);
  }
  const open = narrow ? narrowOpen : wideOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (narrow) setNarrowOpen(next);
      else onOpenChange(next);
    },
    [narrow, onOpenChange],
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
    () => ({ open, setOpen, toggleSidebar, onWidthChange }),
    [open, setOpen, toggleSidebar, onWidthChange],
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

/** The sidebar's contents, or folded the strip (`rail`), in one column at the window's start under the titlebar row [D69 D226]. */
export function SidebarPanel({ rail, className, children, ...props }: ComponentProps<"div"> & { rail?: ReactNode }) {
  const { open, setOpen, onWidthChange } = useSidebar();
  const [resizing, setResizing] = useState(false);
  const fade = "absolute inset-y-0 start-0 flex transition-opacity duration-200 motion-reduce:transition-none";
  return (
    <div data-slot="sidebar-panel" data-state={open ? "expanded" : "collapsed"} className="relative flex h-full shrink-0">
      {/* Its room, eased: the sidebar's width or the strip's. Still while dragged, but folding mid-drag it eases. */}
      <div data-resizing={(resizing && open) || undefined} className={cx("sidebar-motion relative h-full overflow-clip", open ? "sidebar-panel-width" : "w-rail")}>
        <div inert={!open} className={cx(fade, !open && "opacity-0")}>
          <div data-sidebar="sidebar" className={cx("sidebar-panel-width relative flex h-full flex-col pt-tab-bar text-foreground", className)} {...props}>
            {children}
          </div>
        </div>
        <div inert={open} className={cx(fade, open && "opacity-0")}>
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
          onClose={() => setOpen(false)}
          onOpen={() => setOpen(true)}
        />
      )}
    </div>
  );
}
