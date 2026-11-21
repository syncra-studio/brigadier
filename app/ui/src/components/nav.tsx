import { type ComponentProps, type ReactNode, useId } from "react";

import { ChevronDown } from "../icons";
import { cx } from "./cx";

/*
 * The parts a sidebar panel is built from, whatever it shows: its header, sections whose title folds
 * their list away, and lists of rows.
 */

/**
 * A navigation row (30 tall, r10): icon, label, then anything at its end. Hovered or current
 * (`aria-current`, `data-active`), it is filled; current, its words are white. Inside a `group/row` it stays filled while the pointer is anywhere in the row, its hover
 * actions (RowActionsSlot) too.
 */
export function NavRow({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cx(
        "relative flex min-h-nav-row w-full min-w-0 cursor-pointer items-center gap-2 rounded-row ps-2 pe-1.5 text-start text-sm text-foreground",
        "hover:bg-fill group-hover/row:bg-fill group-has-data-popup-open/row:bg-fill focus-visible:focus-ring page-current:bg-selection page-current:text-primary data-active:bg-selection data-active:text-primary svg:shrink-0 svg:size-icon-md",
        className,
      )}
      {...props}
    />
  );
}

/** The panel's header: a mark at its start, its title, and icon buttons at the end, one row for every page's sidebar [D226 D227]. */
export function NavHeader({ start, title, actions }: { start?: ReactNode; title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex h-tab-bar shrink-0 items-center gap-1 ps-2.5 pe-3">
      {start}
      <h1 className="min-w-0 flex-1 truncate text-nav-title font-semibold">{title}</h1>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}

// A section's title: tertiary grey, hovered too [D27].
const TITLE = "text-sm font-medium text-faint-foreground";
// Shown while the section is hovered or holds focus.
const ON_HOVER = "opacity-0 group-focus-within/section:opacity-100 group-hover/section:opacity-100";
// Shown while the title row itself is: a row hovered below shows only the chevron.
const ON_HEAD_HOVER = "opacity-0 group-focus-within/head:opacity-100 group-hover/head:opacity-100";

/**
 * A section of the panel, titled unless set apart by its gap alone. With `onOpenChange` its title folds the
 * list away and opens it again; the chevron turns. `actions` show at the header's end while the header is
 * hovered; `steadyEnd` shows after them always.
 */
export function NavSection({
  title,
  open = true,
  onOpenChange,
  actions,
  steadyActions = false,
  steadyEnd,
  steadyChevron = false,
  scrollList = false,
  children,
}: {
  title?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  actions?: ReactNode;
  /** Its actions show without a hover. */
  steadyActions?: boolean;
  /** Shows at the very end without a hover, beside actions that wait for one. */
  steadyEnd?: ReactNode;
  /** Its chevron shows without a hover. */
  steadyChevron?: boolean;
  /** In a parent of bounded height, its list scrolls under a title that stays. */
  scrollList?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={title ? id : undefined} className={cx("group/section flex flex-col", scrollList && "min-h-0")}>
      {title && (
        <div className="group/head mb-1 flex h-section-title shrink-0 items-center gap-1 ps-2 pe-1.5">
          {onOpenChange ? (
            <button
              id={id}
              type="button"
              aria-expanded={open}
              onClick={() => onOpenChange(!open)}
              className={cx("group/title flex min-w-0 cursor-pointer items-center gap-1 rounded-xs focus-visible:focus-ring", TITLE)}
            >
              <span className="truncate">{title}</span>
              <span className="flex">
                <ChevronDown
                  className={cx(
                    "size-icon-sm shrink-0 transition-all motion-reduce:transition-none",
                    !open && "-rotate-90",
                    open && !steadyChevron && ON_HOVER,
                  )}
                />
              </span>
            </button>
          ) : (
            <h2 id={id} className={cx("truncate", TITLE)}>
              {title}
            </h2>
          )}
          <div className="ms-auto flex shrink-0 items-center gap-0.5">
            {actions && <div className={cx("flex items-center gap-0.5", !steadyActions && ON_HEAD_HOVER)}>{actions}</div>}
            {steadyEnd}
          </div>
        </div>
      )}
      <NavFold open={open} scroll={scrollList}>
        {children}
      </NavFold>
    </section>
  );
}

/** Content that folds away to nothing and opens again: height and opacity ease over 300ms. */
export function NavFold({ open, scroll = false, children }: { open: boolean; scroll?: boolean; children: ReactNode }) {
  return (
    <div inert={!open} className={cx("fold-motion", scroll && "min-h-0")}>
      <div className={cx("min-h-0", scroll ? "overflow-y-auto" : "overflow-hidden")}>{children}</div>
    </div>
  );
}

/** A list of rows, a hair apart. */
export function NavList({ children, className }: { children: ReactNode; className?: string }) {
  return <ul className={cx("flex flex-col gap-px", className)}>{children}</ul>;
}
