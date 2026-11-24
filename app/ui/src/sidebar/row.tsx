import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { type MouseEvent, type ReactNode, useEffect, useState } from "react";

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/context-menu";
import { cx } from "../components/cx";
import { NavFold, NavList, NavRow } from "../components/nav";
import { RowAction, RowActionsSlot } from "../components/row-action";
import { StateDot } from "../components/state-dot";
import { spacingPx, Tooltip, TooltipTrigger } from "../components/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../components/menu";
import { Chat, ChevronRight, Comment, DotsHorizontal, SidebarError, SidebarQuestion, SidebarSpinner, SidebarWorking } from "../icons";
import { ArchiveRowAction } from "../sessions/archive";
import { useMark } from "../session/turn";
import { RowMenuItems } from "./menu";
import { hueOf, type Mark, type Project, projectInitials, type SessionRow, useStatusWords } from "./words";

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

// Ten playful hues, one per project by its name's hash [D283], or the one picked in its settings.
export const TAGS = ["bg-tile-coral", "bg-tile-mint", "bg-tile-sunflower", "bg-tile-violet", "bg-tile-sky", "bg-tile-tangerine", "bg-tile-lime", "bg-tile-pink", "bg-tile-periwinkle", "bg-tile-rose"];

// Every badge's one square and corners, initials or logo, so none is wider than another [D62].
const BADGE = "shrink-0 overflow-hidden rounded-badge";

// Which projects have a logo, asked once a page load (main looks once a run).
const logos = new Map<string, boolean>();

/**
 * A row's badge: its project's logo when its folder has one (main's `/project-icon/`), else its initials in that
 * project's hue, picked from its name; an icon picked in its settings comes first. Initials show while the logo is looked for. `size` is its square and its initials' size, larger in the strip [D811].
 */
export function ProjectBadge({ id, name, icon, size = "size-icon-md text-badge" }: { id?: string; name: string | null; icon?: string | null; size?: string }) {
  const [, found] = useState(false);
  // An image that won't load, its file gone: drawn as with no icon.
  const [broken, setBroken] = useState<string>();
  // Picked in its settings (Rust's projects/icon.rs): `tag:<n>`, `emoji:<it>` or `image:<file>`.
  const [kind, value = ""] = icon && name !== null && icon !== broken ? [icon.slice(0, icon.indexOf(":")), icon.slice(icon.indexOf(":") + 1)] : [];
  if (kind === "image")
    return <img aria-hidden alt="" src={`/project-icon/${encodeURIComponent(id ?? "")}/${encodeURIComponent(value)}`} onError={() => setBroken(icon!)} className={cx(BADGE, size, "object-cover")} />;
  if (kind === "emoji")
    return (
      <span aria-hidden className={cx(BADGE, size, "flex items-center justify-center bg-fill")}>
        {/* Its own size, as `size`'s is the initials': the glyph fills the badge. */}
        <span className="text-base leading-none">{value}</span>
      </span>
    );
  if (kind === "tag") return <span aria-hidden className={cx(BADGE, size, "flex items-center justify-center font-bold text-tile-ink", TAGS[Number(value)])}>{projectInitials(name!)}</span>;
  const logo = id === undefined || name === null ? false : logos.get(id);
  const src = `/project-icon/${encodeURIComponent(id ?? "")}`;
  if (logo)
    return (
      <img
        aria-hidden
        alt=""
        src={src}
        onError={() => {
          logos.set(id!, false);
          setBroken(src);
        }}
        className={cx(BADGE, size, "object-cover")}
      />
    );
  return (
    <span aria-hidden className={cx(BADGE, size, "flex items-center justify-center font-bold", name === null ? "bg-fill text-marker-foreground" : cx("text-tile-ink", TAGS[hueOf(name, TAGS.length)]))}>
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

/** Marks by how much they need the user, a folded Brigade's first [D189 D308]. */
const URGENT: Mark[] = ["needs", "amber", "working", "unread", "background", null];

/** How long a pointer rests on a row before its card shows; on to the next row it shows at once. */
export const CARD_DELAY_MS = 300;
const CARD_LINE = "flex min-h-6 min-w-0 items-center gap-2 text-label text-strip-foreground";

/**
 * A sidebar row's one trailing mark, and nothing else [D63]: a spinner while it runs, a small dot when it has
 * something new or needs you, blue as the old app's [D173]. `label` names it.
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
        <span role="img" aria-label={label} className="size-1.5 rounded-capsule bg-link" />
      </span>
    );
  return null;
}

const ROW_SLOT = "flex h-5 w-5.25 shrink-0 items-center justify-center";
// Hovered or focused, a row's mark gives way to its actions over its end, the title making room for them.
export const HIDE_ON_HOVER = "group-hover/row:hidden group-has-focus-visible/row:hidden group-has-data-popup-open/row:hidden";
export const ROOM_FOR_TWO = "group-hover/row:pe-14 group-has-focus-visible/row:pe-14 group-has-data-popup-open/row:pe-14";
// A session row's "…" and Archive, two 22 squares 6 apart, 8 from the end [D302].
const ROOM_FOR_THREAD = "group-hover/row:pe-16 group-has-focus-visible/row:pe-16 group-has-data-popup-open/row:pe-16";

/**
 * A session on one line [D31]: with `badged` (the one list) its project's badge first, or without one the chat
 * badge View's menu shows; `indent`, under its project, at the project name's x; then its title and its mark. Resting on
 * it, or focusing it, opens a card beside the sidebar with the title, the mark in plain words and the project. The row you
 * are looking at (`active`) draws its thread's mark (`useMark`). Hovered, keyboard-focused or with its menu open, "…" (its
 * actions, as a right-click) then Archive show over its end, in place of the mark [D185, D302]. A Brigade
 * with sessions (`fold`) leads with a chevron that folds them, ← and → too; folded, its mark is the most pressing of theirs
 * and its own. One of them (`sub`) sits a step in, a guide line curving into it [D308].
 */
export function SessionRowItem({
  row,
  project,
  active,
  badged = false,
  canPin = true,
  indent = false,
  fold,
  sub,
  offline = false,
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
  canPin?: boolean;
  /** Under its project's row. */
  indent?: boolean;
  /** A Brigade with sessions, folding them under it. */
  fold?: { open: boolean; toggle: () => void; marks: Mark[] } | undefined;
  /** A Brigade's session in its tree: `last`, the tree's last, where its guide line ends. */
  sub?: "mid" | "last" | undefined;
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
  const own = useMark(row, active);
  const mark = fold && !fold.open ? [own, ...fold.marks].toSorted((a, b) => URGENT.indexOf(a) - URGENT.indexOf(b))[0]! : own;
  const words = useStatusWords(row);
  // Folded, a mark of its sessions' says so.
  const label = mark === own ? (words ?? "") : mark === "working" ? "A session in it is working" : "A session in it needs your attention";
  const title = row.title || "New session";
  // Archived rows bring their own menu (Restore, Delete), and no Pin or Archive.
  const live = !menu && !row.archived;
  const items = menu ?? <RowMenuItems row={row} project={canPin ? project : undefined} canPin={canPin} onRename={() => onRename(row)} />;
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
                className={cx("pe-1.5 data-picked:bg-picked data-picked:group-hover/row:bg-picked data-picked:group-has-data-popup-open/row:bg-picked data-picked:text-foreground", live && ROOM_FOR_THREAD, indent && (sub ? "ps-14" : "ps-8"), !indent && sub && "ps-8")}
                aria-expanded={fold?.open}
                onKeyDown={(event) => fold && (event.key === "ArrowRight") !== fold.open && ["ArrowRight", "ArrowLeft"].includes(event.key) && fold.toggle()}
                onClick={(event) => {
                  if (fold && (event.target as Element).closest('[data-slot="row-fold"]')) return fold.toggle();
                  if (onClick) onClick(event);
                  else onOpen(row.id);
                }}
              />
            }
          >
            {fold && (
              <span data-slot="row-fold" title={fold.open ? "Hide its sessions" : "Show its sessions"} className="-m-0.5 flex size-5 shrink-0 items-center justify-center rounded-xs text-muted-foreground hover:bg-fill hover:text-foreground">
                <ChevronRight className={cx("size-icon-sm transition-transform motion-reduce:transition-none", fold.open && "rotate-90")} />
              </span>
            )}
            {/* A chat with no project: the OpenAI SDK Chat icon, as its tab [D218 D214]. */}
            {badged && (project ? <ProjectBadge id={project.id} name={project.name} icon={project.icon} /> : <Chat aria-hidden className="size-icon-md shrink-0" />)}
            <span className={cx("min-w-0 flex-1 truncate", Boolean(row.archived) && "text-marker-foreground")}>{title}</span>
            {/* On Archive's square, so the actions take the mark's place [D302]. */}
            <span className={cx("flex shrink-0 empty:hidden", live && cx("me-0.5", HIDE_ON_HOVER), offline && "opacity-disabled")}>
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
                    <RowMark mark={row.mark} label={words} />
                    <span className={cx(row.mark && "-ms-0.5")}>{words}</span>
                  </div>
                )}
                {project && (
                  <>
                    <div className="border-t border-border" />
                    <div className={cx(CARD_LINE, "text-sm")}>
                      <ProjectBadge id={project.id} name={project.name} icon={project.icon} />
                      <span className="min-w-0 wrap-anywhere">{project.name}</span>
                    </div>
                  </>
                )}
              </BaseTooltip.Popup>
            </BaseTooltip.Positioner>
          </BaseTooltip.Portal>
        </Tooltip>
        {/* The guide down from its Brigade's chevron, curving into this row and on to the next [D308]. */}
        {sub && (
          <span aria-hidden className={cx("pointer-events-none absolute inset-y-0", indent ? "start-10" : "start-4")}>
            <span className="absolute -top-px start-0 h-1/2 w-3 rounded-es-sm border-s border-b border-marker" />
            {sub === "mid" && <span className="absolute -top-px -bottom-px start-0 border-s border-marker" />}
          </span>
        )}
        {live && (
          <RowActionsSlot thread>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger render={<RowAction thread aria-label={`Actions for ${title}`} />}>
                <DotsHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">{items}</DropdownMenuContent>
            </DropdownMenu>
            <ArchiveRowAction row={row} />
          </RowActionsSlot>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>{items}</ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * A Brigade's tree [D308]: its row (`head`), then its sessions (`children`) folding under it. It opens as one of them
 * starts working, and otherwise stays as the user left it.
 */
export function BrigadeTree({ head, open, working, onOpen, children }: { head: ReactNode; open: boolean; working: boolean; onOpen: () => void; children: ReactNode }) {
  useEffect(() => {
    if (working) onOpen();
  }, [working]);
  return (
    <>
      {head}
      <li>
        <NavFold open={open}>
          <NavList>{children}</NavList>
        </NavFold>
      </li>
    </>
  );
}
