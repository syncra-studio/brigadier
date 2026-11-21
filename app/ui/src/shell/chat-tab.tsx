import { type MouseEvent as ReactMouseEvent, useState } from "react";

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/context-menu";
import { cx } from "../components/cx";
import { ConfirmDialog } from "../components/confirm-dialog";
import { Kbd } from "../components/kbd";
import { DropdownMenuItem, DropdownMenuSeparator } from "../components/menu";
import { showToast } from "../components/toast";
import { setHomeDraft } from "../home/start";
import { store } from "../onboarding/api";
import { Archive, Chat, House, SidebarError, X } from "../icons";
import { BrigadeGlyph } from "../sessions/brigade";
import { useMark } from "../session/turn";
import { rename } from "../sidebar/actions";
import { RenameDialog } from "../sidebar/menu";
import { RowMark } from "../sidebar/row";
import { type SessionRow, useStatusWords } from "../sidebar/words";
import { CHAT, closeOthers, closeRight, selectTab } from "./tab-store";

/* The tabs that aren't a session's own: its Chat tab, the draft's and the house (tab-bar.tsx) [D848]. */
// A tab [D44]: 32 tall on the row's middle line, its fill (session-tab's ::after) in front and on hover only.
export const TAB = "session-tab app-no-drag group/tab flex min-w-0 items-center select-none";
export const LOOK = (active: boolean) => (active ? "text-foreground" : "text-toolbar-foreground");
// Its 16 icon and title from the start, 10 in, 7 from the end; a title too long fades out [D44].
export const BUTTON = "flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-session-tab ps-2.5 pe-1.75 focus-visible:focus-ring";
export const TITLE = "tab-title min-w-0 flex-1 text-start";
// Room for × where it shows: in front always, in back on hover [D44].
export const TITLE_CLOSABLE = "group-hover/tab:me-5 group-data-active/tab:me-5";
// The house, Chrome's pinned tab: its icon alone [D848].
export const PINNED = "flex h-full w-full cursor-pointer items-center justify-center rounded-session-tab focus-visible:focus-ring";
// ×: a 20 square 7 from the end, its 14 glyph, its own hover square; on the front tab always, others on hover [D44].
export const CLOSE = cx(
  "pointer-events-none absolute end-1.75 inset-y-0 my-auto flex size-5 cursor-pointer items-center justify-center rounded-sm opacity-0 hover:bg-fill hover:text-foreground focus-visible:focus-ring focus-visible:opacity-100",
  "group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 group-data-active/tab:pointer-events-auto group-data-active/tab:opacity-100",
);
export const noAutoscroll = (event: ReactMouseEvent) => event.button === 1 && event.preventDefault();

/** ⌘N while ⌘ is held, at the tab's end where its × is [D48]. */
export const Keycap = ({ keycap }: { keycap?: string | undefined }) => (keycap ? <Kbd variant="chip" className="h-5 shrink-0">{keycap}</Kbd> : null);

/** The tab bar's Close all tabs asks first, for the owner here; never the Chat tab [D50]. */
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
  if (row) setHomeDraft(row.project ? { project: row.project, chat: false, locked: true } : { chat: true, locked: false });
  window.location.hash = "";
  if (row?.mark === "working" || row?.mark === "needs") showToast("Still running. Reopen it from the sidebar.");
}

export function TabMenuItems({ owner, id, order, onClose }: { owner: string; id: string; order: string[]; onClose: () => void }) {
  return (
    <>
      <DropdownMenuItem onClick={onClose}>Close</DropdownMenuItem>
      <DropdownMenuItem disabled={order.length <= (id === CHAT ? 1 : 2)} onClick={() => closeOthers(owner, id)}>
        Close other tabs
      </DropdownMenuItem>
      <DropdownMenuItem disabled={order.indexOf(id) === order.length - 1} onClick={() => closeRight(owner, id)}>
        Close tabs to the right
      </DropdownMenuItem>
      <DropdownMenuItem disabled={order.length <= 1} onClick={() => closingAll.set(owner)}>
        Close all tabs
      </DropdownMenuItem>
    </>
  );
}

/** A chat or session's first tab, never moved: its title and its state; its actions are the row's "…" (toolbar.tsx). It
 *  has no × [D45 D427]; ⌘W, middle-click and Close leave it. */
export function ChatTab({ owner, row, active, separator, order, grouped = false, keycap }: { owner: string; row: SessionRow; active: boolean; separator: boolean; order: string[]; grouped?: boolean; keycap?: string | undefined }) {
  const [renaming, setRenaming] = useState(false);
  const words = useStatusWords(row);
  const archived = Boolean(row.archived);
  // A start Rust hasn't titled yet shows no name, not "Chat", for the moment until its title lands [D102].
  const title = row.title || (row.state === "starting" ? "" : "Chat");
  const working = useMark(row, true) === "working" && !archived;
  const startRename = archived ? undefined : () => setRenaming(true);
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div data-tab-id={CHAT} data-separator={separator || undefined} data-active={active || undefined} data-agent-group={grouped || undefined} className={cx(TAB, LOOK(active))} />}>
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
          {archived ? <Archive className="size-icon-md shrink-0" /> : row.mark === "amber" ? <SidebarError className="size-icon-md shrink-0 rotate-180 text-warning" /> : row.brigade ? <BrigadeGlyph className="size-icon-md shrink-0" /> : <Chat className="size-icon-md shrink-0" />}
          <span className={TITLE}>{title}</span>
          {working && !keycap && <RowMark mark="working" label={words ?? ""} />}
          <Keycap keycap={keycap} />
        </button>
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
export function BlankChatTab({ owner, active, closing, separator, onClose, keycap }: { owner: string; active: boolean; closing: boolean; separator: boolean; onClose?: (() => void) | undefined; keycap?: string | undefined }) {
  return (
    <div data-tab-id={CHAT} data-separator={separator || undefined} data-active={active || undefined} data-closing={closing || undefined} aria-hidden={closing || undefined} inert={closing} className={cx(TAB, LOOK(active))}>
      <button type="button" role="tab" aria-selected={active} tabIndex={active ? 0 : -1} title="Chat" onMouseDown={noAutoscroll} onClick={() => selectTab(owner, CHAT)} className={BUTTON}>
        <Chat className="size-icon-md shrink-0" />
        <span className={cx(TITLE, onClose && !keycap && TITLE_CLOSABLE)}>Chat</span>
        <Keycap keycap={keycap} />
      </button>
      {/* A project's draft closes as any tab, its tabs with it [D865]. */}
      {onClose && !keycap && (
        <button type="button" aria-label="Close Chat tab" onClick={onClose} className={CLOSE}>
          <X className="size-icon-sm" />
        </button>
      )}
    </div>
  );
}

/** The house, Chrome's pinned tab, fixed first in a session and in a project: its project's page, in front there [D819
 *  D828 D829 D848], as a tab [D70]. Outside the tablist, as it opens a page rather than a tab; the same box
 *  everywhere, so it holds its place between a session and its project's page [D834]. */
export function HouseTab({ active, separator, onOpen }: { active: boolean; separator: boolean; onOpen: () => void }) {
  return (
    <div className="flex h-8 w-home-tab shrink-0">
      <div data-home data-active={active || undefined} data-separator={separator || undefined} className={cx(TAB, LOOK(active))}>
        <button type="button" title="Home" aria-label="Home" aria-current={active ? "page" : undefined} onMouseDown={noAutoscroll} onClick={onOpen} className={PINNED}>
          <House className="size-icon-md shrink-0" />
        </button>
      </div>
    </div>
  );
}
