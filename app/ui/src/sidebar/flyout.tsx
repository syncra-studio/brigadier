import { type ReactNode, useEffect, useRef, useState } from "react";

import { cx } from "../components/cx";
import { EmptyState } from "../components/empty-state";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenuLabel } from "../components/menu";
import { NavList, NavRow } from "../components/nav";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { spacingPx } from "../components/tooltip";
import { Archive, ArrowUpRight, Chats } from "../icons";
import { openProject } from "../projects/page";
import { useMark } from "../session/turn";
import { openSettings } from "../settings/shell";
import { ProjectBadge, RowMark } from "./row";
import { type Project, type SessionRow, useStatusWords } from "./words";

/*
 * The strip's squares, a project's or a session's [D805, D811], and its lists, each opening beside it to pick from
 * without expanding the sidebar: Chats, which stands for the Chats section [D813], and Archived [D211].
 */

type Choose = (choice: () => void) => void;
type Rows = { active: string | null; offline: boolean; onOpen: (id: string) => void };

/** The mark a row draws: needs-you and unread aren't drawn on the session you're looking at. */
const markOf = (row: SessionRow, active: string | null) => (row.id === active && (row.mark === "needs" || row.mark === "unread") ? null : row.mark);

/** A strip icon and its list, with a blue dot while anything in it has a mark. It closes on a pick (`pick` runs the choice and closes it), on Esc and on a click outside. */
function Flyout({ label, icon, lit = false, children }: { label: string; icon: ReactNode; lit?: boolean; children: (pick: Choose) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const pick: Choose = (choice) => {
    setOpen(false);
    choice();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<TooltipIconButton look="strip" side="right" tooltip={label} dot={lit ? "bg-link" : undefined} />}>{icon}</PopoverTrigger>
      {/* Focus lands on the list itself, not its first row, so Tab goes on into the rows. */}
      <PopoverContent
        ref={list}
        initialFocus={list}
        side="right"
        align="start"
        sideOffset={() => spacingPx() * 3}
        aria-label={label}
        padded={false}
        className="flex max-h-available w-72 flex-col overflow-y-auto p-1.5"
      >
        {children(pick)}
      </PopoverContent>
    </Popover>
  );
}

/** A session in a list: its title and mark; picking it opens it. */
function Line({ row, pick, active, offline, onOpen }: Rows & { row: SessionRow; pick: Choose }) {
  const here = row.id === active;
  const words = useStatusWords(row);
  const mark = useMark(row, here);
  return (
    <li>
      <NavRow aria-current={here ? "page" : undefined} title={words ?? undefined} className="pe-1.5" onClick={() => pick(() => onOpen(row.id))}>
        <span className={cx("min-w-0 flex-1 truncate", Boolean(row.archived) && "text-marker-foreground")}>{row.title || "New session"}</span>
        <span className={cx("flex shrink-0 empty:hidden", offline && "opacity-disabled")}>
          <RowMark mark={mark} label={words ?? ""} />
        </span>
      </NavRow>
    </li>
  );
}

/** What the sidebar says with no projects, its link adding one. */
export function NoProjects({ onAdd }: { onAdd: () => void }) {
  return (
    <span>
      Projects group sessions on a repository.{" "}
      <button type="button" className="cursor-pointer text-foreground underline-offset-link hover:underline" onClick={onAdd}>
        Add a project
      </button>
    </span>
  );
}

/**
 * Whether a project row or strip square shows its one blue mark: a session under it needs you, failed, warned or
 * finished unseen, every kind the same mark [D844]; the open session left out.
 */
export const attentionOf = (rows: SessionRow[], active: string | null) => rows.some((row) => row.id !== active && (row.mark === "needs" || row.mark === "amber" || row.mark === "unread"));

/** A project's square in the strip: its logo or initials, a dot while something in it needs you; a click opens its page [D811]. */
export function ProjectSquare({ project, tone, current, attention }: { project: Project; tone: number; current: boolean; attention: boolean }) {
  return (
    <TooltipIconButton look="strip" side="right" tooltip={project.name} pressed={current} dot={attention ? "bg-link" : undefined} onClick={() => openProject(project.id)}>
      <ProjectBadge id={project.id} name={project.name} tone={tone} size="size-6 text-2xs" />
    </TooltipIconButton>
  );
}

/** A session's square, smaller than a project's; a folded Brigade carries its sessions' attention, as its expanded row does [D805]. */
export function SessionSquare({ row, project, tone, active, attention, onOpen }: { row: SessionRow; project: Project | undefined; tone: number; active: boolean; attention: boolean; onOpen: (id: string) => void }) {
  return (
    <TooltipIconButton look="strip" side="right" tooltip={row.title || "New session"} pressed={active} dot={attention ? "bg-link" : undefined} onClick={() => onOpen(row.id)}>
      <ProjectBadge id={project?.id} name={project?.name ?? null} tone={tone} size="size-4.5 text-badge" />
    </TooltipIconButton>
  );
}

/**
 * The strip's squares, scrolling under a fade (the sidebar list's) and ending above the foot's icons, which rise over
 * the strip from the card's bottom: their height is measured into `data-foot` [D803].
 */
export function Squares({ children }: { children: ReactNode }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const foot = list.current?.closest("[data-sidebar]")?.querySelector("[data-slot=sidebar-foot]");
    if (!foot) return;
    const measure = () => {
      const below = list.current!.parentElement!.getBoundingClientRect().bottom - foot.getBoundingClientRect().top;
      list.current!.setAttribute("data-foot", String(Math.max(0, Math.round(below))));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(foot);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={list} className="strip-squares scroll-edge-fade edge-fade-sidebar hide-scrollbar flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto pb-2">
      {children}
    </div>
  );
}

/** The chats: this branch has no chats, so those are the sessions in no project, as View's filter counts them. */
export function ChatsFlyout({ chats, ...rows }: Rows & { chats: SessionRow[] }) {
  return (
    <Flyout label="Chats" icon={<Chats />} lit={chats.some((row) => markOf(row, rows.active))}>
      {(pick) => (
        <div className="flex flex-col gap-3">
          <section>
            <DropdownMenuLabel variant="heading" role="heading" aria-level={2}>
              Chats
            </DropdownMenuLabel>
            <NavList>
              {chats.map((row) => (
                <Line key={row.id} row={row} pick={pick} {...rows} />
              ))}
              {chats.length === 0 && <EmptyState as="li" title="Chats you start appear here." />}
            </NavList>
          </section>
        </div>
      )}
    </Flyout>
  );
}

/** How many are archived, and the arrow to Settings › Archived. */
export function ArchivedActions({ count }: { count: number }) {
  return (
    <>
      <span className="me-1 text-xs text-faint-foreground tabular-nums">{count}</span>
      <TooltipIconButton tooltip="Open Settings › Archived" className="text-muted-foreground" onClick={() => openSettings("archived")}>
        <ArrowUpRight />
      </TooltipIconButton>
    </>
  );
}

/** The archived sessions, opened read-only as from the Archived section. */
export function ArchivedFlyout({ archived, ...rows }: Rows & { archived: SessionRow[] }) {
  return (
    <Flyout label="Archived" icon={<Archive />}>
      {(pick) => (
        <section>
          <div className="flex items-center justify-between">
            <DropdownMenuLabel variant="heading" role="heading" aria-level={2}>
              Archived
            </DropdownMenuLabel>
            <span className="flex items-center">
              <ArchivedActions count={archived.length} />
            </span>
          </div>
          <NavList>
            {archived.map((row) => (
              <Line key={row.id} row={row} pick={pick} {...rows} />
            ))}
          </NavList>
        </section>
      )}
    </Flyout>
  );
}
