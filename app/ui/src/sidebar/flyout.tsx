import { type ReactNode, useRef, useState } from "react";

import { cx } from "../components/cx";
import { EmptyState } from "../components/empty-state";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenuLabel } from "../components/menu";
import { NavList, NavRow } from "../components/nav";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { spacingPx } from "../components/tooltip";
import { Archive, ArrowUpRight, Chats, Folder, Folders } from "../icons";
import { newSessionIn } from "../projects/menu";
import { openAddProject } from "../projects/store";
import { RowMark } from "./row";
import { type Project, type SessionRow, statusWords } from "./words";

/*
 * The strip's lists, each opening beside it to pick from without expanding the sidebar: Projects and Chats as
 * in the old app, and Archived [D211].
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
function Line({ row, nested = false, pick, active, offline, onOpen }: Rows & { row: SessionRow; nested?: boolean; pick: Choose }) {
  const here = row.id === active;
  const words = statusWords(row);
  return (
    <li>
      <NavRow aria-current={here ? "page" : undefined} title={words ?? undefined} className={cx("pe-1.5", nested && "ps-8")} onClick={() => pick(() => onOpen(row.id))}>
        <span className={cx("mask-fade-end min-w-0 flex-1 overflow-hidden whitespace-nowrap", Boolean(row.archived) && "text-marker-foreground")}>{row.title || "New session"}</span>
        <span className={cx("flex shrink-0 empty:hidden", offline && "opacity-disabled")}>
          <RowMark mark={markOf(row, active)} label={words ?? ""} />
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

/** Each project, picked to start a session in it, with its sessions. */
export function ProjectsFlyout({ projects, sessions, ...rows }: Rows & { projects: Project[]; sessions: SessionRow[] }) {
  return (
    <Flyout label="Projects" icon={<Folders />} lit={sessions.some((row) => markOf(row, rows.active) && projects.some((project) => project.id === row.project))}>
      {(pick) =>
        projects.length === 0 ? (
          <p className="px-2 py-1 text-sm text-muted-foreground">
            <NoProjects onAdd={() => pick(() => openAddProject())} />
          </p>
        ) : (
          <NavList>
            {projects.map((project) => (
              <li key={project.id} className="flex flex-col">
                <NavRow title={`New session in ${project.name}`} onClick={() => pick(() => newSessionIn(project.id))}>
                  <Folder />
                  <span className="mask-fade-end min-w-0 flex-1 overflow-hidden whitespace-nowrap">{project.name}</span>
                </NavRow>
                <NavList className="pt-px pb-1">
                  {sessions
                    .filter((row) => row.project === project.id)
                    .map((row) => (
                      <Line key={row.id} row={row} nested pick={pick} {...rows} />
                    ))}
                </NavList>
              </li>
            ))}
          </NavList>
        )
      }
    </Flyout>
  );
}

/** The pinned sessions, then the chats. This branch has no chats, so those are the sessions in no project, as View's filter counts them. */
export function ChatsFlyout({ pinned, chats, ...rows }: Rows & { pinned: SessionRow[]; chats: SessionRow[] }) {
  return (
    <Flyout label="Chats" icon={<Chats />} lit={[...pinned, ...chats].some((row) => markOf(row, rows.active))}>
      {(pick) => (
        <div className="flex flex-col gap-3">
          {pinned.length > 0 && (
            <section>
              <DropdownMenuLabel variant="heading" role="heading" aria-level={2}>
                Pinned
              </DropdownMenuLabel>
              <NavList>
                {pinned.map((row) => (
                  <Line key={row.id} row={row} pick={pick} {...rows} />
                ))}
              </NavList>
            </section>
          )}
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
      {/* No click yet: the page it opens, Settings › Archived, doesn't exist. */}
      <TooltipIconButton tooltip="Open Settings › Archived" className="text-muted-foreground">
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
