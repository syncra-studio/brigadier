import { type FormEvent, type ReactNode, useState } from "react";

import { Button } from "../components/button";
import { ConfirmForm } from "../components/confirm-dialog";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/context-menu";
import { cx } from "../components/cx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { Input } from "../components/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/menu";
import { NavFold, NavList, NavRow } from "../components/nav";
import { RowAction, RowActionsSlot } from "../components/row-action";
import { showToast } from "../components/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Archive, ComposeEditSquare, DotsHorizontal, Folder, FolderOpen, Pencil, Pin, Unpin, X } from "../icons";
import { newSession } from "../home/start";
import { errorText, run, store } from "../onboarding/api";
import { openProject } from "../projects/page";
import { pinProject, setProject, type Project } from "../projects/projects";
import { openRemoveProject, readRemoval } from "../projects/remove";
import { archiveRows } from "../sessions/archive";
import { HIDE_ON_HOVER, ProjectBadge, ROOM_FOR_TWO, SidebarMark } from "./row";
import type { SessionRow } from "./words";

/** The project a rename or an Archive chats asks about, with the chats it would archive. */
const asking = store<{ project: Project; archive?: SessionRow[] } | null>(null);

/**
 * A project's row [D28 D30]: its badge and name; a click opens and closes its sessions under it (`children`,
 * at the name's x), "No chats" when it has none. Hovered, "…" (its actions, as a right-click) and New session [D62].
 * Folded, a dot says a session in it has something new or needs you.
 */
export function ProjectRow({ project, tone, current, open, onToggle, attention, chats, children }: {
  project: Project;
  tone: number;
  /** Its page shows. */
  current: boolean;
  open: boolean;
  onToggle: () => void;
  attention: boolean;
  /** Its live sessions, for Archive chats. */
  chats: SessionRow[];
  children: ReactNode;
}) {
  const items = <ProjectMenuItems project={project} chats={chats} />;
  return (
    <li data-project-id={project.id}>
      <ContextMenu onOpenChange={(next) => next && readRemoval(project.id)}>
        <ContextMenuTrigger render={<div className="group/row relative" />}>
          <NavRow aria-expanded={open} aria-current={current ? "page" : undefined} className={cx("pe-1.5", ROOM_FOR_TWO)} onClick={onToggle}>
            {/* Its logo, else its initials, in place of a folder [D28]. */}
            <ProjectBadge id={project.id} name={project.name} tone={tone} />
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            <span className={cx("flex shrink-0 empty:hidden", HIDE_ON_HOVER)}>{!open && attention && <SidebarMark mark="unread" label="A session needs your attention" />}</span>
          </NavRow>
          <RowActionsSlot>
            <DropdownMenu modal={false} onOpenChange={(next) => next && readRemoval(project.id)}>
              <DropdownMenuTrigger render={<RowAction aria-label={`Actions for ${project.name}`} />}>
                <DotsHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">{items}</DropdownMenuContent>
            </DropdownMenu>
            <Tooltip>
              <TooltipTrigger render={<RowAction aria-label={`New session in ${project.name}`} onClick={() => newSession(project.id)} />}>
                <ComposeEditSquare />
              </TooltipTrigger>
              <TooltipContent side="bottom">New session</TooltipContent>
            </Tooltip>
          </RowActionsSlot>
        </ContextMenuTrigger>
        <ContextMenuContent>{items}</ContextMenuContent>
      </ContextMenu>
      <NavFold open={open}>
        <NavList className="pt-px pb-2">
          {children}
          {chats.length === 0 && <li className="flex h-nav-row items-center ps-8 text-sm text-faint-foreground">No chats</li>}
        </NavList>
      </NavFold>
    </li>
  );
}

/** A project's actions, in this order [D29 D30]. */
function ProjectMenuItems({ project, chats }: { project: Project; chats: SessionRow[] }) {
  const reveal = () => void run(["projects", "reveal", project.id]).catch((cause) => showToast(`Couldn't reveal ${project.name}: ${errorText(cause)}`, { tone: "error" }));
  return (
    <>
      <DropdownMenuItem onClick={() => openProject(project.id)}>
        <Folder />
        Open project
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => pinProject(project, !project.pinned)}>
        {project.pinned ? <Unpin /> : <Pin />}
        {project.pinned ? "Unpin" : "Pin"}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => asking.set({ project })}>
        <Pencil />
        Rename…
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={reveal}>
        <FolderOpen />
        Reveal in Finder
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={chats.length === 0} onClick={() => asking.set({ project, archive: chats })}>
        <Archive />
        Archive chats
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => openRemoveProject(project.id)}>
        <X />
        Remove project…
      </DropdownMenuItem>
    </>
  );
}

/** Rename's form and Archive chats' confirm, mounted once by the sidebar. */
export function ProjectAsk() {
  const now = asking.use();
  const close = () => asking.set(null);
  const archive = now?.archive;
  return (
    <Dialog open={now !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent showCloseButton={false}>
        {now && archive && (
          <ConfirmForm
            title={`Archive ${archive.length === 1 ? "1 chat" : `${archive.length} chats`} in ${now.project.name}?`}
            description="Restore brings each one back."
            confirm="Archive"
            onConfirm={() => {
              close();
              archiveRows(archive);
            }}
            onCancel={close}
          />
        )}
        {now && !archive && <RenameForm key={now.project.id} project={now.project} onClose={close} />}
      </DialogContent>
    </Dialog>
  );
}

/** The project's name, as its Settings' Name saves it. */
function RenameForm({ project, onClose }: { project: Project; onClose: () => void }) {
  const [value, setValue] = useState(project.name);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = value.trim();
    if (!name) return setError("Name can't be empty.");
    if (name !== project.name) void setProject(project, { name }, ["--name", name]).catch((cause) => showToast(`Couldn't rename ${project.name}: ${errorText(cause)}`, { tone: "error" }));
    onClose();
  };
  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Rename project</DialogTitle>
      </DialogHeader>
      <div className="grid gap-1.5">
        <label htmlFor="rename-project" className="text-xs text-muted-foreground">
          Name
        </label>
        <Input id="rename-project" value={value} autoFocus aria-invalid={error !== null} onChange={(event) => setValue(event.target.value)} />
        <ErrorLine error={error} />
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">Rename</Button>
      </DialogFooter>
    </form>
  );
}
