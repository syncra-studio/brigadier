import { type ReactNode, useRef, useState } from "react";

import { cx } from "../components/cx";
import { EmptyState } from "../components/empty-state";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenuLabel } from "../components/menu";
import { NavList, NavRow } from "../components/nav";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { spacingPx } from "../components/tooltip";
import { newSession } from "../home/start";
import { Archive, ArrowUpRight, Chats, ComposeEditSquare, Settings } from "../icons";
import { openProject } from "../projects/page";
import { useMark } from "../session/turn";
import { openSettings } from "../settings/shell";
import { ProjectBadge, SidebarMark } from "./row";
import { type Project, type SessionRow, useStatusWords } from "./words";

/*
 * The strip's squares, a project's or a session's [D805, D811], and its lists, each opening beside it to pick from
 * without expanding the sidebar: a project's [D278], Chats, which stands for the Chats section [D813], and Archived [D211].
 */

type Choose = (choice: () => void) => void;
type Rows = { active: string | null; offline: boolean; onOpen: (id: string) => void };

/** A list's section: its heading stays, only its rows scroll, so what's above and below it stays in view [D280]. */
function Section({ heading, actions, children }: { heading: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const title = (
    <DropdownMenuLabel variant="heading" role="heading" aria-level={2} className="min-w-0 truncate">
      {heading}
    </DropdownMenuLabel>
  );
  return (
    <section className="flex min-h-0 flex-col">
      {actions ? (
        <div className="flex items-center justify-between">
          {title}
          <span className="flex items-center">{actions}</span>
        </div>
      ) : (
        title
      )}
      <NavList className="min-h-0 overflow-y-auto">{children}</NavList>
    </section>
  );
}

/** A strip icon and its list, with a blue dot while anything in it needs you, failed or has a new reply. It closes on a pick (`pick` runs the choice and closes it), on Esc and on a click outside. */
function Flyout({ label, icon, lit = false, pressed, children }: { label: string; icon: ReactNode; lit?: boolean; pressed?: boolean; children: (pick: Choose) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const pick: Choose = (choice) => {
    setOpen(false);
    choice();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<TooltipIconButton look="rail" side="right" tooltip={label} pressed={pressed} dot={lit ? "bg-link" : undefined} />}>{icon}</PopoverTrigger>
      {/* Focus lands on the list itself, not its first row, so Tab goes on into the rows. */}
      <PopoverContent
        ref={list}
        initialFocus={list}
        side="right"
        align="start"
        sideOffset={() => spacingPx() * 3}
        aria-label={label}
        padded={false}
        className="flex max-h-available w-72 flex-col p-1.5"
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
          <SidebarMark mark={mark} label={words ?? ""} />
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

/** A project's square in the strip: its logo or initials, a dot while something in it needs you; a click opens its list,
 *  styled as Chats': New chat in it, its chats, then its settings page [D278 D176]. */
export function ProjectSquare({ project, current, attention, chats, ...rows }: Rows & { project: Project; current: boolean; attention: boolean; chats: SessionRow[] }) {
  return (
    <Flyout label={project.name} icon={<ProjectBadge id={project.id} name={project.name} size="size-6 text-2xs" />} lit={attention} pressed={current}>
      {(pick) => (
        <div className="flex min-h-0 flex-col gap-3">
          <NavList>
            <li>
              <NavRow onClick={() => pick(() => newSession(project.id))}>
                <ComposeEditSquare />
                New chat
              </NavRow>
            </li>
          </NavList>
          <Section heading={project.name}>
            {chats.map((row) => (
              <Line key={row.id} row={row} pick={pick} {...rows} />
            ))}
            {chats.length === 0 && <EmptyState as="li" title="Chats you start in this project appear here." />}
          </Section>
          <NavList>
            <li>
              <NavRow onClick={() => pick(() => openProject(project.id))}>
                <Settings />
                Project settings
              </NavRow>
            </li>
          </NavList>
        </div>
      )}
    </Flyout>
  );
}

/** A session's square, smaller than a project's; a folded Brigade carries its sessions' attention, as its expanded row does [D805]. */
export function SessionSquare({ row, project, active, attention, onOpen }: { row: SessionRow; project: Project | undefined; active: boolean; attention: boolean; onOpen: (id: string) => void }) {
  return (
    <TooltipIconButton look="rail" side="right" tooltip={row.title || "New session"} pressed={active} dot={attention ? "bg-link" : undefined} onClick={() => onOpen(row.id)}>
      <ProjectBadge id={project?.id} name={project?.name ?? null} size="size-4.5 text-badge" />
    </TooltipIconButton>
  );
}

/** The chats: this branch has no chats, so those are the sessions in no project, as View's filter counts them. */
export function ChatsFlyout({ chats, ...rows }: Rows & { chats: SessionRow[] }) {
  return (
    <Flyout label="Chats" icon={<Chats />} lit={attentionOf(chats, rows.active)}>
      {(pick) => (
        <Section heading="Chats">
          {chats.map((row) => (
            <Line key={row.id} row={row} pick={pick} {...rows} />
          ))}
          {chats.length === 0 && <EmptyState as="li" title="Chats you start appear here." />}
        </Section>
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
        <Section heading="Archived" actions={<ArchivedActions count={archived.length} />}>
          {archived.map((row) => (
            <Line key={row.id} row={row} pick={pick} {...rows} />
          ))}
        </Section>
      )}
    </Flyout>
  );
}
