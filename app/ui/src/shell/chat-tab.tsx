import { type MouseEvent as ReactMouseEvent, useState } from "react";

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/context-menu";
import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/menu";
import { showToast } from "../components/toast";
import { setHomeDraft } from "../home/start";
import { Archive, Chat, DotsHorizontal, House, SidebarError, X } from "../icons";
import { BrigadeGlyph } from "../sessions/brigade";
import { useMark } from "../session/turn";
import { rename } from "../sidebar/actions";
import { RenameDialog, RowMenuItems } from "../sidebar/menu";
import { RowMark } from "../sidebar/row";
import { type SessionRow, useStatusWords } from "../sidebar/words";
import { CHAT, closeOthers, closeRight, selectTab, SIBLING } from "./tab-store";

/* The tabs that aren't a session's own: its Chat tab, the draft's and the house (tab-bar.tsx) [D848]. */
// Chrome's tabs: every one the same box down to the frame, in front or not, so choosing one moves nothing; the front one
// draws its shape (Shape) [D832 D834 D848].
export const TAB = "session-tab @container/tab app-no-drag group/tab flex min-w-0 items-center gap-1 px-1 select-none";
export const LOOK = (active: boolean) => (active ? "text-foreground" : "text-toolbar-foreground");
/** The front tab's shape, Chrome's, joined to the frame; every tab has one, shown in front only (session-tab-shape). */
export const Shape = () => <span aria-hidden className="session-tab-shape" />;
// Its icon and title from the start, a title too long cut with "…"; squeezed under 88px, the icon alone [D52].
export const BUTTON = "flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm ps-2 pe-1 focus-visible:focus-ring @max-tab-icon/tab:justify-center @max-tab-icon/tab:px-0";
export const TITLE = "@max-tab-icon/tab:hidden min-w-0 truncate";
// The house, Chrome's pinned tab: its icon alone [D848].
export const PINNED = "flex h-full w-full cursor-pointer items-center justify-center rounded-sm focus-visible:focus-ring";
// × at the tab's end on every tab, as Chrome's, centred above the foot with the content [D937]; none under 64px.
export const CLOSE = "absolute end-2 top-0 bottom-session-tab-foot my-auto flex @max-tab-close/tab:hidden size-5 cursor-pointer items-center justify-center rounded-capsule opacity-tab-close hover:bg-fill hover:opacity-100 focus-visible:focus-ring";
export const noAutoscroll = (event: ReactMouseEvent) => event.button === 1 && event.preventDefault();

/** Leaves the session for Home; it goes on working and stays in the sidebar. */
export function leave(row: SessionRow | undefined): void {
  if (row) setHomeDraft(row.project ? { project: row.project, chat: false, locked: true } : { chat: true, locked: false });
  window.location.hash = "";
  if (row?.mark === "working" || row?.mark === "needs") showToast("Still running. Reopen it from the sidebar.");
}

export function TabMenuItems({ owner, id, order, onClose }: { owner: string; id: string; order: string[]; onClose: () => void }) {
  return (
    <>
      <DropdownMenuItem onClick={onClose}>Close</DropdownMenuItem>
      <DropdownMenuItem disabled={order.length <= (id === CHAT ? 1 : 2)} onClick={() => closeOthers(owner, id)}>
        Close others
      </DropdownMenuItem>
      <DropdownMenuItem disabled={order.indexOf(id) === order.length - 1} onClick={() => closeRight(owner, id)}>
        Close to the right
      </DropdownMenuItem>
    </>
  );
}

/** A chat or session's first tab, never moved: its title, its state and its ⋯. It has no × [D427]; ⌘W, middle-click and Close leave it. */
export function ChatTab({ owner, row, active, separator, order, grouped = false }: { owner: string; row: SessionRow; active: boolean; separator: boolean; order: string[]; grouped?: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const words = useStatusWords(row);
  const archived = Boolean(row.archived);
  // A start Rust hasn't titled yet shows no name, not "Chat", for the moment until its title lands [D102].
  const title = row.title || (row.state === "starting" ? "" : "Chat");
  const working = useMark(row, true) === "working" && !archived;
  const startRename = archived ? undefined : () => setRenaming(true);
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div data-tab-id={CHAT} data-separator={separator || undefined} data-active={active || undefined} data-agent-group={grouped || undefined} data-glide={grouped ? SIBLING + row.id : undefined} className={cx(TAB, LOOK(active))} />}>
        <Shape />
        <button
          type="button"
          role="tab"
          aria-selected={active}
          tabIndex={active ? 0 : -1}
          title={archived ? `${title} (Archived)` : words ? [title, words].filter(Boolean).join(" · ") : title}
          onMouseDown={noAutoscroll}
          onMouseUp={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            leave(row);
          }}
          onClick={() => selectTab(owner, CHAT)}
          onDoubleClick={startRename}
          className={BUTTON}
        >
          {archived ? <Archive className="size-icon-sm shrink-0" /> : row.mark === "amber" ? <SidebarError className="size-icon-sm shrink-0 rotate-180 text-warning" /> : row.brigade ? <BrigadeGlyph className="size-icon-sm shrink-0" /> : <Chat className="size-icon-sm shrink-0" />}
          <span className={TITLE}>{title}</span>
        </button>
        {!archived && (
          <span className="grid shrink-0 place-items-center">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger
                render={<TooltipIconButton look="toolbar" size="icon-xs" tooltip="Session actions" className={cx("col-start-1 row-start-1", working && "invisible group-hover/tab:visible group-has-focus-visible/tab:visible aria-expanded:visible")} />}
              >
                <DotsHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <RowMenuItems row={row} onRename={() => setRenaming(true)} />
              </DropdownMenuContent>
            </DropdownMenu>
            {working && (
              <span className="pointer-events-none col-start-1 row-start-1 group-hover/tab:invisible group-has-focus-visible/tab:invisible group-has-aria-expanded/tab:invisible">
                <RowMark mark="working" label={words ?? ""} />
              </span>
            )}
          </span>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <DropdownMenuItem disabled={!startRename} onClick={startRename}>
          Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <TabMenuItems owner={owner} id={CHAT} order={order} onClose={() => leave(row)} />
      </ContextMenuContent>
      <RenameDialog row={renaming ? row : null} onClose={() => setRenaming(false)} onRename={(name, branch) => rename(row, name, branch)} />
    </ContextMenu>
  );
}

/** The Chat tab before there's a session to act on: Home's draft, or a row not read yet. New chat with no tabs, or a
 *  project's page with nothing current, has none: it shrinks out as the others do and grows back with them [D831 D836 D850]. */
export function BlankChatTab({ owner, active, closing, separator, onClose }: { owner: string; active: boolean; closing: boolean; separator: boolean; onClose?: (() => void) | undefined }) {
  return (
    <div data-tab-id={CHAT} data-separator={separator || undefined} data-active={active || undefined} data-closing={closing || undefined} aria-hidden={closing || undefined} inert={closing} className={cx(TAB, LOOK(active))}>
      <Shape />
      <button type="button" role="tab" aria-selected={active} tabIndex={active ? 0 : -1} title="Chat" onMouseDown={noAutoscroll} onClick={() => selectTab(owner, CHAT)} className={cx(BUTTON, onClose && "pe-7")}>
        <Chat className="size-icon-sm shrink-0" />
        <span className={TITLE}>Chat</span>
      </button>
      {/* A project's draft closes as any tab, its tabs with it [D865]. */}
      {onClose && (
        <button type="button" aria-label="Close Chat tab" onClick={onClose} className={CLOSE}>
          <X className="size-icon-xs" />
        </button>
      )}
    </div>
  );
}

/** The house, Chrome's pinned tab, fixed first in a session and in a project: its project's page, in front there [D819
 *  D828 D829 D848]. Outside the tablist, as it opens a page rather than a tab; the same box everywhere, so it holds its
 *  place between a session and its project's page [D834]. */
export function HouseTab({ active, separator, onOpen }: { active: boolean; separator: boolean; onOpen: () => void }) {
  return (
    <div className="-me-2 flex h-tab-front w-home-tab shrink-0 self-end">
      <div data-home data-active={active || undefined} data-separator={separator || undefined} className={cx(TAB, LOOK(active))}>
        <Shape />
        <button type="button" title="Home" aria-label="Home" aria-current={active ? "page" : undefined} onMouseDown={noAutoscroll} onClick={onOpen} className={PINNED}>
          <House className="size-icon-md shrink-0" />
        </button>
      </div>
    </div>
  );
}
