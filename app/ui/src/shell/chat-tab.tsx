import { type MouseEvent as ReactMouseEvent, useState } from "react";

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/context-menu";
import { cx } from "../components/cx";
import { ConfirmDialog } from "../components/confirm-dialog";
import { Kbd } from "../components/kbd";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/menu";
import { showToast } from "../components/toast";
import { newChatIn, setHomeDraft } from "../home/start";
import { store } from "../onboarding/api";
import { Archive, Chat, ChatCompose, DotsHorizontal, Pencil, SidebarError, X } from "../icons";
import { useProjects } from "../projects/projects";
import { BrigadeGlyph } from "../sessions/brigade";
import { useMark } from "../session/turn";
import { rename } from "../sidebar/actions";
import { RenameDialog, RowMenuItems } from "../sidebar/menu";
import { ProjectBadge, RowMark } from "../sidebar/row";
import { type SessionRow, useStatusWords } from "../sidebar/words";
import { CHAT, closeOthers, closeRight, HOME, selectTab } from "./tab-store";

/* The tabs that aren't a session's own: its Chat tab and the draft's (tab-bar.tsx) [D848]. */
// A tab [D44]: 32 tall on the row's middle line, its fill (session-tab's ::after) in front and on hover only.
export const TAB = "session-tab app-no-drag group/tab flex min-w-0 items-center select-none";
export const LOOK = (active: boolean) => (active ? "text-chat-title" : "text-toolbar-foreground");
// Its 16 icon and title from the start, 10 in, 7 from the end; a title too long fades out [D44].
export const BUTTON = "flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-session-tab ps-2.5 pe-1.75 focus-visible:focus-ring";
export const TITLE = "tab-title min-w-0 flex-1 text-start";
// Room for × where it shows: in front always, in back on hover [D44].
export const TITLE_CLOSABLE = "group-hover/tab:me-5 group-data-active/tab:me-5";
// ×: a 20 square 7 from the end, its 14 glyph, its own hover square; on the front tab always, others on hover [D44].
const CLOSE_AT_REST = "pointer-events-none absolute end-1.75 inset-y-0 my-auto flex size-5 cursor-pointer items-center justify-center rounded-sm opacity-0 hover:bg-fill hover:text-foreground focus-visible:focus-ring focus-visible:opacity-100";
export const CLOSE = cx(CLOSE_AT_REST, "group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 group-data-active/tab:pointer-events-auto group-data-active/tab:opacity-100");
// Working, the chat's spinner and its "…" share the ×'s slot: the "…" on hover, keyboard focus or while its menu is open, else the spinner [D287].
const SWAP_IN = "group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 group-has-focus-visible/tab:pointer-events-auto group-has-focus-visible/tab:opacity-100 data-popup-open:pointer-events-auto data-popup-open:opacity-100";
const SWAP_OUT = "group-hover/tab:invisible group-has-data-popup-open/tab:invisible group-has-focus-visible/tab:invisible";
export const noAutoscroll = (event: ReactMouseEvent) => event.button === 1 && event.preventDefault();

/** ⌘N while ⌘ is held, at the tab's end where its × is [D48]. */
export const Keycap = ({ keycap }: { keycap?: string | undefined }) => (keycap ? <Kbd variant="chip" className="h-5 shrink-0">{keycap}</Kbd> : null);

/** The tab menu's Close all asks first, for the owner here; never the Chat tab [D50]. */
const closingAll = store<string | null>(null);
export function CloseAllDialog() {
  const owner = closingAll.use();
  return (
    <ConfirmDialog
      open={owner !== null}
      onOpenChange={(open) => !open && closingAll.set(null)}
      title="Close all tabs?"
      description="Every tab but the chat closes."
      confirm="Close"
      destructive
      onConfirm={() => {
        if (owner !== null) closeOthers(owner, CHAT);
        closingAll.set(null);
      }}
    />
  );
}

/** Leaves the session for Home; it goes on working and stays in the sidebar. */
export function leave(row: SessionRow | undefined): void {
  // A chat in no project goes back to New chat's draft as it was left [D282].
  if (row) setHomeDraft(row.project ? { project: row.project, chat: false, locked: true } : { locked: false });
  window.location.hash = "";
  if (row?.mark === "working" || row?.mark === "needs") showToast("Still running. Reopen it from the sidebar.");
}

export function TabMenuItems({ owner, id, order, onClose }: { owner: string; id: string; order: string[]; onClose: () => void }) {
  return (
    <>
      {/* The tab's menu: each Close an × [D73]. */}
      <DropdownMenuItem onClick={onClose}>
        <X />
        Close
      </DropdownMenuItem>
      <DropdownMenuItem disabled={order.length <= (id === CHAT ? 1 : 2)} onClick={() => closeOthers(owner, id)}>
        <X />
        Close others
      </DropdownMenuItem>
      <DropdownMenuItem disabled={order.indexOf(id) === order.length - 1} onClick={() => closeRight(owner, id)}>
        <X />
        Close to the right
      </DropdownMenuItem>
      <DropdownMenuItem disabled={order.length <= 1} onClick={() => closingAll.set(owner)}>
        <X />
        Close all
      </DropdownMenuItem>
    </>
  );
}

/** The chat's project icon, its sidebar row's badge [D36]; a Chat bubble with no project [D214]. */
function ProjectIcon({ project }: { project: string | null | undefined }) {
  const projects = useProjects() ?? [];
  const named = projects.find((each) => each.id === project);
  return named ? <ProjectBadge id={named.id} name={named.name} /> : <Chat aria-hidden className="size-icon-md shrink-0" />;
}

/** A chat or session's first tab, never moved: its title and its state, and its "…" with the row's actions. It has no
 *  × [D45 D427 D197]; ⌘W, middle-click and Close leave it. `plain` while it's the only tab: no chip, its title plain in
 *  the titlebar, until a tab opens and it grows into tab 1 [D196]. */
export function ChatTab({ owner, row, active, plain, separator, order, keycap }: { owner: string; row: SessionRow; active: boolean; plain: boolean; separator: boolean; order: string[]; keycap?: string | undefined }) {
  const [renaming, setRenaming] = useState(false);
  const words = useStatusWords(row);
  const archived = Boolean(row.archived);
  // A start Rust hasn't titled yet shows no name, not "Chat", for the moment until its title lands [D102].
  const title = row.title || (row.state === "starting" ? "" : "Chat");
  const working = useMark(row, true) === "working" && !archived;
  const startRename = archived ? undefined : () => setRenaming(true);
  const label = archived ? `${title} (Archived)` : words ? [title, words].filter(Boolean).join(" · ") : title;
  const icon = archived ? <Archive className="size-icon-md shrink-0" /> : row.mark === "amber" ? <SidebarError className="size-icon-md shrink-0 rotate-180 text-warning" /> : row.brigade ? <BrigadeGlyph className="size-icon-md shrink-0" /> : <ProjectIcon project={row.project} />;
  const middleLeaves = (event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    leave(row);
  };
  // The chat's actions [D37]: New chat in this worktree, a one-off [D152], then the row's menu [D185].
  const actions = (
    <DropdownMenuContent align={plain ? "start" : "end"}>
      {row.project && row.folder && (
        <>
          <DropdownMenuItem onClick={() => newChatIn(row.project!, row.folder!, row.title)}>
            <ChatCompose />
            New chat in this worktree
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}
      <RowMenuItems row={row} onRename={() => setRenaming(true)} />
    </DropdownMenuContent>
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div data-tab-id={CHAT} data-plain={plain || undefined} data-separator={separator || undefined} data-active={active || undefined} className={cx(TAB, LOOK(active))} />}>
        <button
          type="button"
          role="tab"
          aria-selected={active}
          tabIndex={active ? 0 : -1}
          title={label}
          onMouseDown={noAutoscroll}
          onMouseUp={middleLeaves}
          onClick={() => selectTab(owner, CHAT)}
          onDoubleClick={startRename}
          // Plain, it's a title, not a button [D230].
          className={cx(BUTTON, plain && "cursor-default!")}
        >
          {icon}
          <span className={cx(TITLE, !plain && !archived && !keycap && (working ? "me-5" : TITLE_CLOSABLE))}>{title}</span>
          <Keycap keycap={keycap} />
        </button>
        {/* Never at the row's end [D200]: its own toggle right after the plain title [D222], or in the tab where another's × is. */}
        {!archived && !keycap && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger render={plain ? <TooltipIconButton look="bar" tooltip="Chat actions" className={cx("shrink-0", working && cx("opacity-0", SWAP_IN))} /> : <button type="button" aria-label="Chat actions" className={working ? cx(CLOSE_AT_REST, SWAP_IN) : CLOSE} />}>
              <DotsHorizontal className={plain ? undefined : "size-icon-sm"} />
            </DropdownMenuTrigger>
            {actions}
          </DropdownMenu>
        )}
        {/* Over the "…"'s own square, so the title's width holds as they swap. */}
        {working && !keycap && (
          <span className={cx("pointer-events-none absolute inset-y-0 flex items-center justify-center", plain ? "end-0 w-7" : "end-1.75 w-5", SWAP_OUT)}>
            <RowMark mark="working" label={words ?? ""} />
          </span>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <DropdownMenuItem disabled={!startRename} onClick={startRename}>
          <Pencil />
          Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <TabMenuItems owner={owner} id={CHAT} order={order} onClose={() => leave(row)} />
      </ContextMenuContent>
      <RenameDialog row={renaming ? row : null} onClose={() => setRenaming(false)} onRename={(name, branch) => rename(row, name, branch)} />
    </ContextMenu>
  );
}

/** The Chat tab before there's a session to act on: Home's draft, New chat in its project, or a session whose row isn't
 *  read yet, blank until its title lands [D102]; a PR's review draft is named for it [D197]. No ×, as no chat tab has [D45 D197]. With no other tab there's none:
 *  it shrinks out as the others do and grows back with them [D831 D836 D196]. */
export function BlankChatTab({ owner, project, title = owner === HOME ? "New chat" : "", active, closing, separator, keycap }: { owner: string; project: string | null; title?: string | undefined; active: boolean; closing: boolean; separator: boolean; keycap?: string | undefined }) {
  return (
    <div data-tab-id={CHAT} data-separator={separator || undefined} data-active={active || undefined} data-closing={closing || undefined} aria-hidden={closing || undefined} inert={closing} className={cx(TAB, LOOK(active))}>
      <button type="button" role="tab" aria-selected={active} tabIndex={active ? 0 : -1} title={title} onMouseDown={noAutoscroll} onClick={() => selectTab(owner, CHAT)} className={BUTTON}>
        <ProjectIcon project={project} />
        <span className={TITLE}>{title}</span>
        <Keycap keycap={keycap} />
      </button>
    </div>
  );
}
