import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { MouseEvent, ReactNode } from "react";

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/context-menu";
import { cx } from "../components/cx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../components/menu";
import { NavRow } from "../components/nav";
import { RowAction, RowActionsSlot } from "../components/row-action";
import { StateDot } from "../components/state-dot";
import { spacingPx, Tooltip, TooltipTrigger } from "../components/tooltip";
import { DotsHorizontal, SidebarError, SidebarQuestion, SidebarWorking } from "../icons";
import { RowMenuItems } from "./menu";
import { type Mark, type Project, projectInitials, type SessionRow, statusWords } from "./words";

const SLOT = "flex size-icon-lg shrink-0 items-center justify-center";

/** A row's one mark, no words [D173]: spinner, blue ring, amber ring, blue dot, or nothing. `label` names it. */
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
    default:
      return null;
  }
}

/** A row's badge: its project's initials in grey. */
export function ProjectBadge({ name }: { name: string }) {
  return (
    <span aria-hidden className="flex size-icon-md shrink-0 items-center justify-center rounded-xs bg-fill text-badge font-semibold text-marker-foreground">
      {projectInitials(name)}
    </span>
  );
}

/** How long a pointer rests on a row before its card shows; on to the next row it shows at once. */
const CARD_DELAY_MS = 300;
const CARD_LINE = "flex min-h-6 min-w-0 items-center gap-2 text-label text-strip-foreground";

/**
 * A session on one line: with `badged` (the one list) its project's badge first, then its title and one
 * mark. Resting on it, or focusing it, opens a card beside the sidebar with the title, the mark in plain
 * words and the project. Needs-you and unread marks aren't drawn on the row you're looking at (`active`).
 * Its actions are in a ⋯ menu over its end on hover, and on a right-click [D185].
 */
export function SessionRowItem({
  row,
  project,
  active,
  badged = false,
  nested = false,
  offline = false,
  held,
  picked = false,
  menu,
  onOpen,
  onClick,
  onRename,
}: {
  row: SessionRow;
  project: Project | undefined;
  active: boolean;
  badged?: boolean;
  nested?: boolean;
  /** The daemon is gone: the mark is its last known one, dimmed. */
  offline?: boolean;
  onOpen: (id: string) => void;
  onRename: (row: SessionRow) => void;
  /** The gallery's box: the card shows there, held open. */
  held?: HTMLElement;
  /** One of several picked with ⌘- or Shift-click [D185]. */
  picked?: boolean;
  /** Its menu, in place of the live row's (an archived row's Restore and Delete…). */
  menu?: ReactNode;
  /** A click with its keys, in place of opening it. */
  onClick?: (event: MouseEvent) => void;
}) {
  const mark = active && (row.mark === "needs" || row.mark === "unread") ? null : row.mark;
  const words = statusWords(row);
  const label = words ?? "";
  const title = row.title || "New session";
  const items = menu ?? <RowMenuItems row={row} active={active} onRename={() => onRename(row)} />;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<li data-row-id={row.id} className="group/row relative" />}>
        <Tooltip open={held && true}>
          <TooltipTrigger
            delay={CARD_DELAY_MS}
            render={
              <NavRow
                aria-current={active ? "page" : undefined}
                data-picked={picked || undefined}
                className={cx("pe-1.5 data-picked:bg-picked data-picked:text-foreground", nested && "ps-8", badged && "h-9")}
                onClick={(event) => (onClick ? onClick(event) : onOpen(row.id))}
              />
            }
          >
            {badged && project && <ProjectBadge name={project.name} />}
            <span className="mask-fade-end min-w-0 flex-1 overflow-hidden whitespace-nowrap">{title}</span>
            <span className={cx("flex shrink-0 empty:hidden group-has-focus-visible/row:invisible group-hover/row:invisible group-has-aria-expanded/row:invisible", offline && "opacity-disabled")}>
              <RowMark mark={mark} label={label} />
            </span>
          </TooltipTrigger>
          <BaseTooltip.Portal container={held}>
            {/* Past the row's own inset, clear of the sidebar's edge. */}
            <BaseTooltip.Positioner
              side="right"
              align="start"
              sideOffset={() => spacingPx() * 4}
              collisionAvoidance={held && { side: "none", align: "none" }}
              className="z-popup"
            >
              <BaseTooltip.Popup className="pointer-events-none flex w-66 flex-col rounded-surface border border-border bg-popover px-3 py-2.5 text-start text-sm text-foreground shadow-tooltip popup-motion">
                <p className="mb-1 line-clamp-3 font-medium wrap-anywhere">{title}</p>
                {words && (
                  <div className={cx(CARD_LINE, row.mark && "-ms-0.5")}>
                    <RowMark mark={row.mark} label={label} />
                    <span className={cx(row.mark && "-ms-0.5")}>{words}</span>
                  </div>
                )}
                {project && (
                  <>
                    <div className="my-1.5 border-t border-divider" />
                    <div className={CARD_LINE}>
                      <ProjectBadge name={project.name} />
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
        </RowActionsSlot>
      </ContextMenuTrigger>
      <ContextMenuContent>{items}</ContextMenuContent>
    </ContextMenu>
  );
}
