import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { matches } from "../shortcuts";
import { cx } from "./cx";
import { TooltipProvider } from "./tooltip";

/*
 * The sidebar panel: expanded to its width, collapsed to a strip of icons, or fully hidden. It eases
 * between these (the content beside it moves with it) while its contents cross-fade; hiding slides it off
 * the window's start and showing slides it back, at the width it has there [D63]; the
 * expanded contents keep their full width, revealed rather than squeezed. ⌘B (Ctrl elsewhere) toggles
 * it. Each of the three has one fixed width, nothing drags [D804]. In a narrow window it collapses by
 * itself, and comes back once there is room. While `keepOpen` it stays expanded.
 *
 * It holds nothing: open and collapse come in, and changes go out (the app remembers them).
 */

export type SidebarCollapse = "strip" | "hidden";

type SidebarContextProps = {
  state: "expanded" | "collapsed";
  open: boolean;
  collapse: SidebarCollapse;
  /** Picks strip or hidden for when it collapses (the sidebar toggle steps through them). */
  setCollapse: (collapse: SidebarCollapse) => void;
  hidden: boolean;
  /** Whether the card draws its open layout: open, or hidden from open (it slides off and back at the width it had). */
  drawn: boolean;
  /** The last fold went into or out of hidden: the card slides off or onto the window's start, its width and contents set [D63]. */
  slide: boolean;
  setOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  /** Whether it can collapse here (not while held open). */
  canToggle: boolean;
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

export function SidebarProvider({
  open: wideOpen,
  onOpenChange,
  collapse = "strip",
  onCollapseChange = () => {},
  keepOpen = false,
  className,
  children,
  ...props
}: Omit<ComponentProps<"div">, "onChange"> & {
  /** Expanded while the window has room: the app's remembered choice. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Collapsed to a strip of icons, or hidden. */
  collapse?: SidebarCollapse;
  onCollapseChange?: (collapse: SidebarCollapse) => void;
  keepOpen?: boolean;
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
  // Every path (the sidebar toggle, ⌘B, View › Toggle Sidebar) steps open → strip → hidden → open [D800].
  const toggleSidebar = useCallback(() => {
    if (keepOpen) return;
    if (open) onCollapseChange("strip");
    else if (collapse === "strip") onCollapseChange("hidden");
    setOpen(!open && collapse === "hidden");
  }, [keepOpen, open, collapse, onCollapseChange, setOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matches(event, "sidebar")) return;
      event.preventDefault();
      if (!event.repeat) toggleSidebar();
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [toggleSidebar]);

  const hidden = !open && collapse === "hidden";
  const state = open ? "expanded" : "collapsed";
  const mode = open ? "open" : hidden ? "hidden" : "strip";
  const [fold, setFold] = useState({ from: mode, to: mode });
  if (fold.to !== mode) setFold({ from: fold.to, to: mode });
  const slide = fold.from === "hidden" || mode === "hidden";
  const drawn = hidden ? fold.from === "open" : open;
  const context = useMemo<SidebarContextProps>(
    () => ({ state, open, collapse, setCollapse: onCollapseChange, hidden, drawn, slide, setOpen, toggleSidebar, canToggle: !keepOpen }),
    [state, open, collapse, onCollapseChange, hidden, drawn, slide, setOpen, toggleSidebar, keepOpen],
  );

  return (
    <SidebarContext.Provider value={context}>
      <TooltipProvider delay={0}>
        <div
          data-slot="sidebar-wrapper"
          data-state={state}
          data-collapse={hidden ? "hidden" : "strip"}
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
 * The panel: on the window's frame, a sidebar [D823]. The expanded
 * contents (`children`) and the strip's (`strip`) cross-fade in the same place; `foot` is shared by both, below them.
 */
export function SidebarPanel({
  strip,
  foot,
  className,
  children,
  ...props
}: ComponentProps<"div"> & { strip?: ReactNode; foot?: ReactNode }) {
  const { open, hidden, drawn, slide } = useSidebar();
  return (
    <div data-slot="sidebar-panel" data-state={open ? "expanded" : "collapsed"} className="relative flex h-full shrink-0">
      <div
        inert={hidden}
        className={cx("sidebar-motion sidebar-clip h-full", open ? "sidebar-panel-width" : hidden ? "w-0" : "w-sidebar-strip")}
      >
        {/* Hiding slides the card off the window's start as its room closes, on the same curve, so its end stays on the room's [D63]. */}
        <div
          data-slide={slide || undefined}
          className={cx(
            "sidebar-motion relative flex h-full flex-col p-1",
            drawn ? "sidebar-panel-width" : "w-sidebar-strip",
            hidden && "-translate-x-full rtl:translate-x-full",
          )}
        >
          <div data-sidebar="sidebar" className={cx("relative flex min-h-0 flex-1 flex-col overflow-clip text-foreground", className)} {...props}>
            <div className="relative min-h-0 flex-1">
              <div
                inert={!open}
                className={cx(
                  "sidebar-card-width absolute inset-y-0 start-0 flex flex-col",
                  !slide && "transition-opacity motion-reduce:transition-none",
                  drawn ? "opacity-100" : "opacity-0",
                )}
              >
                {children}
              </div>
              <div
                inert={open || hidden}
                className={cx(
                  "absolute inset-0 flex flex-col",
                  !slide && "transition-opacity motion-reduce:transition-none",
                  drawn ? "opacity-0" : "opacity-100",
                )}
              >
                {strip}
              </div>
            </div>
            {foot}
          </div>
        </div>
      </div>
    </div>
  );
}
