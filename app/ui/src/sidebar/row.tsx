import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { MouseEvent, ReactNode } from "react";

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/context-menu";
import { cx } from "../components/cx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../components/menu";
import { NavRow } from "../components/nav";
import { RowAction, RowActionsSlot } from "../components/row-action";
import { StateDot } from "../components/state-dot";
import { spacingPx, Tooltip, TooltipTrigger } from "../components/tooltip";
import { BrigadeGlyph } from "../sessions/brigade";
import { BranchAlt, ChevronRight, Comment, DotsHorizontal, SidebarError, SidebarQuestion, SidebarWorking } from "../icons";
import { prList } from "../landing/pr-chip";
import { ArchiveRowAction } from "../sessions/archive";
import { useMark } from "../session/turn";
import { RowMenuItems } from "./menu";
import { type Mark, type Project, projectInitials, type SessionRow, useStatusWords } from "./words";

const SLOT = "flex size-icon-lg shrink-0 items-center justify-center";

/** A row's one mark, no words [D173]: spinner, blue ring, amber ring, blue dot, grey dot, or nothing. `label` names it. */
export function RowMark({ mark, label }: { mark: Mark; label: string }) {
  switch (mark) {
    case "working":
      return (
        <span role="status" aria-label={label} className={SLOT}>
          <SidebarWorking className="size-icon-md text-marker-foreground motion-safe:animate-row-spin" />
        </span>
      );
    case "needs":
      return (
        <span role="img" aria-label={label} className={cx(SLOT, "text-link")}>
          <SidebarQuestion className="size-icon-md" />
        </span>
      );
    case "amber":
      return (
        <span role="img" aria-label={label} className={cx(SLOT, "text-warning")}>
          {/* Turned over, its ring's i reads as an exclamation. */}
          <SidebarError className="size-icon-md rotate-180" />
        </span>
      );
    case "unread":
      return (
        <span className={SLOT}>
          <StateDot tone="unread" label={label} />
        </span>
      );
    case "background":
      return (
        <span role="img" aria-label={label} className={SLOT}>
          <StateDot />
        </span>
      );
    default:
      return null;
  }
}

/** A row's badge: its project's initials, in that project's colour. `tone` is the project's place in Rust's list. */
export function ProjectBadge({ name, tone }: { name: string | null; tone: number | undefined }) {
  return (
    <span aria-hidden data-tone={tone} className={cx("flex h-icon-md min-w-icon-md shrink-0 items-center justify-center rounded-xs px-0.75 text-badge font-bold tracking-badge", name === null ? "bg-fill text-marker-foreground" : "project-tone")}>
      {name === null ? <Comment className="size-icon-xs" /> : projectInitials(name)}
    </span>
  );
}

/** Marks by how much they need the user, a folded Brigade's first [D189]. */
const URGENT: Mark[] = ["needs", "amber", "working", "unread", "background", null];

/** How long a pointer rests on a row before its card shows; on to the next row it shows at once. */
export const CARD_DELAY_MS = 300;
const CARD_LINE = "flex min-h-6 min-w-0 items-center gap-2 text-label text-strip-foreground";

/**
 * A session on one line: with `badged` (the one list) its project's badge first, then its title and one
 * mark. Resting on it, or focusing it, opens a card beside the sidebar with the title, the mark in plain
 * words and the project. The row you are looking at (`active`) draws its thread's mark (`useMark`).
 * Its actions are in a ⋯ menu over its end on hover, with Archive beside it, and on a right-click [D185].
 */
export function SessionRowItem({
  row,
  project,
  tone,
  active,
  badged = false,
  nested = false,
  forked = false,
  sub = false,
  fold,
  offline = false,
  picked = false,
  menu,
  onOpen,
  onClick,
  onRename,
}: {
  row: SessionRow;
  project: Project | undefined;
  /** The project's place in the projects list, for its badge's colour. */
  tone?: number;
  active: boolean;
  badged?: boolean;
  nested?: boolean;
  /** A fork, under its source: the fork mark before its title, one step further in [D48]. */
  forked?: boolean;
  /** A Brigade's sub-session, under its boss [D189]. */
  sub?: boolean;
  /** A Brigade with sessions: they fold under it, and folded it shows their most pressing mark. */
  fold?: { open: boolean; toggle: () => void; marks: Mark[] };
  /** The daemon is gone: the mark is its last known one, dimmed. */
  offline?: boolean;
  onOpen: (id: string) => void;
  onRename: (row: SessionRow) => void;
  /** One of several picked with ⌘- or Shift-click [D185]. */
  picked?: boolean;
  /** Its menu, in place of the live row's (an archived row's Restore and Delete…). */
  menu?: ReactNode;
  /** A click with its keys, in place of opening it. */
  onClick?: (event: MouseEvent) => void;
}) {
  const own = useMark(row, active);
  const mark = fold && !fold.open ? [own, ...fold.marks].toSorted((a, b) => URGENT.indexOf(a) - URGENT.indexOf(b))[0]! : own;
  const words = useStatusWords(row);
  const label = words ?? "";
  const title = row.title || "New session";
  // Archived rows bring their own menu (Restore, Delete…) and no Archive.
  const live = !menu && !row.archived;
  const items = menu ?? <RowMenuItems row={row} onRename={() => onRename(row)} />;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<li data-row-id={row.id} className="group/row relative" />}>
        <Tooltip>
          <TooltipTrigger
            delay={CARD_DELAY_MS}
            render={
              <NavRow
                aria-current={active ? "page" : undefined}
                data-picked={picked || undefined}
                className={cx("pe-1.5 data-picked:bg-picked data-picked:group-hover/row:bg-picked data-picked:group-has-data-popup-open/row:bg-picked data-picked:text-foreground", live ? "group-hover/row:pe-16 group-has-focus-visible/row:pe-16 group-has-aria-expanded/row:pe-16" : "group-hover/row:pe-7 group-has-focus-visible/row:pe-7 group-has-aria-expanded/row:pe-7", nested && (sub ? "ps-15" : forked ? "ps-10" : "ps-8"), !nested && forked && "ps-4", !nested && sub && "ps-15")}
                onKeyDown={(event) => {
                  if (fold && (event.key === "ArrowRight") !== fold.open && ["ArrowRight", "ArrowLeft"].includes(event.key)) fold.toggle();
                }}
                onClick={(event) => {
                  if (fold && (event.target as Element).closest('[data-slot="row-fold"]')) return fold.toggle();
                  if (onClick) onClick(event);
                  else onOpen(row.id);
                }}
              />
            }
          >
            {badged && project && !sub && <ProjectBadge name={project.name} tone={tone} />}
            {row.brigade && !fold && <BrigadeGlyph aria-label="Brigade" className="size-icon-md shrink-0 text-muted-foreground" />}
            {/* Hovered, the mark is the fold's chevron, as on a project folder [D196]; ← and → fold it too. */}
            {fold && (
              <span data-slot="row-fold" title={fold.open ? "Hide its sessions" : "Show its sessions"} className="-m-0.5 flex size-icon-lg shrink-0 items-center justify-center rounded-xs text-muted-foreground hover:bg-fill">
                <BrigadeGlyph aria-label="Brigade" className="size-icon-md group-hover/row:hidden" />
                <ChevronRight className={cx("hidden size-icon-sm group-hover/row:block", fold.open && "rotate-90")} />
              </span>
            )}
            {forked && <BranchAlt aria-label="Fork" className="size-icon-sm shrink-0 text-muted-foreground" />}
            <span className={cx("min-w-0 flex-1 truncate", Boolean(row.archived) && "text-marker-foreground")}>{title}</span>
            <span className={cx("flex shrink-0 empty:hidden", offline && "opacity-disabled")}>
              <RowMark mark={mark} label={label} />
            </span>
          </TooltipTrigger>
          <BaseTooltip.Portal>
            {/* Past the row's own inset, clear of the sidebar's edge. */}
            <BaseTooltip.Positioner
              side="right"
              align="start"
              sideOffset={() => spacingPx() * 4}
              className="z-popup"
            >
              <BaseTooltip.Popup className="pointer-events-none flex w-65 flex-col gap-2.5 rounded-surface border border-popover-edge bg-popover px-3.5 py-3 text-start text-sm text-foreground shadow-overlay backdrop-blur-popover popup-motion">
                <p className="line-clamp-3 font-semibold wrap-anywhere">{title}</p>
                {words && (
                  <div className={cx(CARD_LINE, row.mark && "-ms-0.5")}>
                    <RowMark mark={row.mark} label={label} />
                    <span className={cx(row.mark && "-ms-0.5")}>{words}</span>
                  </div>
                )}
                {row.pr && <div className={CARD_LINE}>{prList(row.pr)}</div>}
                {project && (
                  <>
                    <div className="border-t border-border" />
                    <div className={cx(CARD_LINE, "text-sm")}>
                      <ProjectBadge name={project.name} tone={tone} />
                      <span className="min-w-0 wrap-anywhere">{project.name}</span>
                    </div>
                  </>
                )}
              </BaseTooltip.Popup>
            </BaseTooltip.Positioner>
          </BaseTooltip.Portal>
        </Tooltip>
        <RowActionsSlot>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger render={<RowAction aria-label={`Actions for ${title}`} />}>
              <DotsHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">{items}</DropdownMenuContent>
          </DropdownMenu>
          {live && <ArchiveRowAction row={row} />}
        </RowActionsSlot>
      </ContextMenuTrigger>
      <ContextMenuContent>{items}</ContextMenuContent>
    </ContextMenu>
  );
}
