import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { type MouseEvent, type ReactNode, useState } from "react";

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/context-menu";
import { cx } from "../components/cx";
import { NavRow } from "../components/nav";
import { RowAction, RowActionsSlot } from "../components/row-action";
import { StateDot } from "../components/state-dot";
import { spacingPx, Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Comment, Pin, SidebarError, SidebarQuestion, SidebarSpinner, SidebarWorking, Unpin } from "../icons";
import { prList } from "../landing/pr-chip";
import { ArchiveRowAction } from "../sessions/archive";
import { useMark } from "../session/turn";
import { pin } from "./actions";
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

// Finder's tags in their order, each project the next as it is added, so neighbours differ [new-design].
const TAGS = [
  "bg-tag-red-wash text-tag-red",
  "bg-tag-orange-wash text-tag-orange",
  "bg-tag-yellow-wash text-tag-yellow",
  "bg-tag-green-wash text-tag-green",
  "bg-tag-blue-wash text-tag-blue",
  "bg-tag-purple-wash text-tag-purple",
  "bg-tag-grey-wash text-tag-grey",
];

// Every badge's one square and corners, initials or logo, so none is wider than another [D62].
const BADGE = "shrink-0 overflow-hidden rounded-badge";

// Which projects have a logo, asked once a page load (main looks once a run).
const logos = new Map<string, boolean>();

/**
 * A row's badge: its project's logo when its folder has one (main's `/project-icon/`), else its initials in that
 * project's colour. `tone` is the project's place in the order projects were added, so it keeps its colour as
 * others are added. Initials show while the logo is looked for. `size` is its square and its initials' size, larger in the strip [D811].
 */
export function ProjectBadge({ id, name, tone = 0, size = "size-icon-md text-badge" }: { id?: string; name: string | null; tone: number | undefined; size?: string }) {
  const [, found] = useState(false);
  const logo = id === undefined || name === null ? false : logos.get(id);
  const src = `/project-icon/${encodeURIComponent(id ?? "")}`;
  if (logo) return <img aria-hidden alt="" src={src} className={cx(BADGE, size, "object-cover")} />;
  return (
    <span aria-hidden className={cx(BADGE, size, "flex items-center justify-center font-bold", name === null ? "bg-fill text-marker-foreground" : TAGS[((tone % TAGS.length) + TAGS.length) % TAGS.length])}>
      {name === null ? <Comment className="size-icon-xs" /> : projectInitials(name)}
      {logo === undefined && (
        <img
          hidden
          alt=""
          src={src}
          onLoad={() => {
            logos.set(id!, true);
            found(true);
          }}
          onError={() => logos.set(id!, false)}
        />
      )}
    </span>
  );
}

/** Marks by how much they need the user, a folded Brigade's first [D189]. */
const URGENT: Mark[] = ["needs", "amber", "working", "unread", "background", null];

/** How long a pointer rests on a row before its card shows; on to the next row it shows at once. */
export const CARD_DELAY_MS = 300;
const CARD_LINE = "flex min-h-6 min-w-0 items-center gap-2 text-label text-strip-foreground";

/**
 * A sidebar row's one trailing mark, and nothing else [D63]: a spinner while it runs, a small dot when it has
 * something new or needs you. `label` names it.
 */
export function SidebarMark({ mark, label }: { mark: Mark; label: string }) {
  if (mark === "working")
    return (
      <span role="status" aria-label={label} className={ROW_SLOT}>
        <SidebarSpinner className="size-icon-sm text-foreground motion-safe:animate-row-spin" />
      </span>
    );
  if (mark === "needs" || mark === "amber" || mark === "unread")
    return (
      <span className={ROW_SLOT}>
        <span role="img" aria-label={label} className="size-1.5 rounded-capsule bg-primary" />
      </span>
    );
  return null;
}

const ROW_SLOT = "flex h-5 w-5.25 shrink-0 items-center justify-center";
// Hovered or focused, a row's mark gives way to its actions over its end, the title making room for them.
export const HIDE_ON_HOVER = "group-hover/row:hidden group-has-focus-visible/row:hidden group-has-data-popup-open/row:hidden";
export const ROOM_FOR_ONE = "group-hover/row:pe-8 group-has-focus-visible/row:pe-8 group-has-data-popup-open/row:pe-8";
export const ROOM_FOR_TWO = "group-hover/row:pe-14 group-has-focus-visible/row:pe-14 group-has-data-popup-open/row:pe-14";

/**
 * A session on one line [D31]: with `badged` (the one list) its project's badge first, or without one the chat
 * badge View's menu shows; `indent`, under its project, at the project name's x; then its title and its mark. Resting on
 * it, or focusing it, opens a card beside the sidebar with the title, the mark in plain words and the project. The row you
 * are looking at (`active`) draws its thread's mark (`useMark`). Hovered, Pin (where pins apply) and Archive show over its
 * end; its actions are on a right-click [D185].
 */
export function SessionRowItem({
  row,
  project,
  tone,
  active,
  badged = false,
  canPin = true,
  indent = false,
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
  canPin?: boolean;
  /** Under its project's row. */
  indent?: boolean;
  /** The daemon is gone: the mark is its last known one, dimmed. */
  offline?: boolean;
  onOpen: (id: string) => void;
  onRename: (row: SessionRow) => void;
  /** One of several picked with ⌘- or Shift-click [D185]. */
  picked?: boolean;
  /** Its menu, in place of the live row's (an archived row's Restore and Delete). */
  menu?: ReactNode;
  /** A click with its keys, in place of opening it. */
  onClick?: (event: MouseEvent) => void;
}) {
  const mark = useMark(row, active);
  const words = useStatusWords(row);
  const label = words ?? "";
  const title = row.title || "New session";
  // Archived rows bring their own menu (Restore, Delete), and no Pin or Archive.
  const live = !menu && !row.archived;
  const pins = live && canPin;
  const items = menu ?? <RowMenuItems row={row} canPin={canPin} onRename={() => onRename(row)} />;
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
                className={cx("pe-1.5 data-picked:bg-picked data-picked:group-hover/row:bg-picked data-picked:group-has-data-popup-open/row:bg-picked data-picked:text-foreground", live && (pins ? ROOM_FOR_TWO : ROOM_FOR_ONE), indent && "ps-8")}
                onClick={(event) => (onClick ? onClick(event) : onOpen(row.id))}
              />
            }
          >
            {badged && (project ? <ProjectBadge id={project.id} name={project.name} tone={tone} /> : <ProjectBadge name={null} tone={undefined} />)}
            <span className={cx("min-w-0 flex-1 truncate", Boolean(row.archived) && "text-marker-foreground")}>{title}</span>
            <span className={cx("flex shrink-0 empty:hidden", live && HIDE_ON_HOVER, offline && "opacity-disabled")}>
              <SidebarMark mark={mark} label={label} />
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
                      <ProjectBadge id={project.id} name={project.name} tone={tone} />
                      <span className="min-w-0 wrap-anywhere">{project.name}</span>
                    </div>
                  </>
                )}
              </BaseTooltip.Popup>
            </BaseTooltip.Positioner>
          </BaseTooltip.Portal>
        </Tooltip>
        {live && (
          <RowActionsSlot>
            {pins && (
              <Tooltip>
                <TooltipTrigger render={<RowAction aria-label={row.pinned ? "Unpin" : "Pin"} onClick={() => pin(row, !row.pinned)} />}>{row.pinned ? <Unpin /> : <Pin />}</TooltipTrigger>
                <TooltipContent side="bottom">{row.pinned ? "Unpin" : "Pin"}</TooltipContent>
              </Tooltip>
            )}
            <ArchiveRowAction row={row} />
          </RowActionsSlot>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>{items}</ContextMenuContent>
    </ContextMenu>
  );
}
