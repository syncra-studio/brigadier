import { PointerSensor } from "@dnd-kit/dom";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Badge } from "../components/badge";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/context-menu";
import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/menu";
import { setHomeDraft } from "../home/start";
import { Archive, Chat, Dock, DotsHorizontal, Globe, Plus, SidebarError, X } from "../icons";
import { showToast } from "../components/toast";
import { rename } from "../sidebar/actions";
import { RenameDialog, RowMenuItems } from "../sidebar/menu";
import { RowMark } from "../sidebar/row";
import { type SessionRow, useStatusWords } from "../sidebar/words";
import { useTabKeys } from "./tab-keys";
import { CHAT, closeOthers, closeRight, closeTab, HOME, justOpened, moveTab, openTab, selectTab, type Tab, tabOrder, tabsOf, useTabs, useTabsFromRust } from "./tab-store";
import { blocked } from "./titlebar";
import { Toolbar } from "./toolbar";

/** After a close, how long the pointer may be away from the tabs before they take the room back. */
const CLOSE_LOCK_MS = 300;
/** The closing slide; the tab itself is gone at once. */
const CLOSING_MS = 100;

const TAB = "session-tab app-no-drag group/tab relative flex h-control-md min-w-0 items-center gap-1 rounded-session-tab ps-2.5 pe-1.75 select-none";
const LOOK = (active: boolean) => (active ? "bg-fill shadow-session-tab text-foreground" : "text-toolbar-foreground hover:bg-fill");
const BUTTON = "flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-sm focus-visible:focus-ring";
const TITLE = "session-tab-title min-w-0 flex-1 overflow-hidden text-start whitespace-nowrap";
const CLOSE = (active: boolean) => cx("flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-capsule opacity-tab-close hover:bg-fill hover:opacity-100 focus-visible:focus-ring", !active && "invisible group-focus-within/tab:visible group-hover/tab:visible");
const noAutoscroll = (event: ReactMouseEvent) => event.button === 1 && event.preventDefault();

/** Leaves the session for Home; it goes on working and stays in the sidebar. */
function leave(row: SessionRow | undefined): void {
  if (row) setHomeDraft(row.project ? { project: row.project, chat: false } : { chat: true });
  window.location.hash = "";
  if (row?.mark === "working" || row?.mark === "needs") showToast("Still running. Reopen it from the sidebar.");
}

function TabMenuItems({ owner, id, order, onClose }: { owner: string; id: string; order: string[]; onClose: () => void }) {
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

/** A chat or session's first tab, never moved: its title, its state, its ⋯, and × which only leaves it. */
function ChatTab({ owner, row, active, separator, order }: { owner: string; row: SessionRow; active: boolean; separator: boolean; order: string[] }) {
  const [renaming, setRenaming] = useState(false);
  const words = useStatusWords(row);
  const archived = Boolean(row.archived);
  const title = row.title || "Chat";
  const working = row.mark === "working" && !archived;
  const startRename = archived ? undefined : () => setRenaming(true);
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div data-tab-id={CHAT} data-separator={separator || undefined} data-active={active || undefined} className={cx(TAB, LOOK(active))} />}>
        <button
          type="button"
          role="tab"
          aria-selected={active}
          tabIndex={active ? 0 : -1}
          title={archived ? `${title} (Archived)` : words ? `${title} · ${words}` : title}
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
          {archived ? <Archive className="size-icon-sm shrink-0" /> : row.mark === "amber" ? <SidebarError className="size-icon-sm shrink-0 rotate-180 text-warning" /> : <Chat className="size-icon-sm shrink-0" />}
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
        <button type="button" aria-label={`Close ${title} tab`} onClick={() => leave(row)} className={CLOSE(active)}>
          <X className="size-icon-xs" />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <DropdownMenuItem disabled={!startRename} onClick={startRename}>
          Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <TabMenuItems owner={owner} id={CHAT} order={order} onClose={() => leave(row)} />
      </ContextMenuContent>
      <RenameDialog row={renaming ? row : null} onClose={() => setRenaming(false)} onRename={(name) => rename(row, name)} />
    </ContextMenu>
  );
}

/** The Chat tab before there's a session to act on: Home, or a row not read yet. */
function BlankChatTab({ owner, active, separator }: { owner: string; active: boolean; separator: boolean }) {
  return (
    <div data-tab-id={CHAT} data-separator={separator || undefined} data-active={active || undefined} className={cx(TAB, LOOK(active))}>
      <button type="button" role="tab" aria-selected={active} tabIndex={active ? 0 : -1} title="Chat" onMouseDown={noAutoscroll} onClick={() => selectTab(owner, CHAT)} className={BUTTON}>
        <Chat className="size-icon-sm shrink-0" />
        <span className={TITLE}>Chat</span>
      </button>
    </div>
  );
}

const nameOf = (tab: Tab) => (tab.kind === "new" ? "New tab" : "Terminal");

/** A tab it opened: the kind's icon, its name and ×. Its button is the drag handle, as a button inside a sortable won't start one otherwise; Alt+←/→ moves it from the keyboard. */
function OtherTab({ owner, tab, index, last, selected, separator, closing, order, onClose }: { owner: string; tab: Tab; index: number; last: number; selected: boolean; separator: boolean; closing: boolean; order: string[]; onClose: () => void }) {
  const { ref, handleRef, isDragging } = useSortable({ id: tab.id, index, disabled: closing });
  const [fresh] = useState(() => justOpened(tab.id));
  const name = nameOf(tab);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            ref={ref}
            data-session-tab
            data-tab-id={tab.id}
            data-fresh={fresh || undefined}
            data-closing={closing || undefined}
            aria-hidden={closing || undefined}
            inert={closing}
            data-separator={separator || undefined}
            data-active={selected || undefined}
            className={cx(TAB, LOOK(selected), isDragging && "z-10 opacity-disabled")}
          />
        }
      >
        <button
          ref={handleRef}
          type="button"
          role="tab"
          aria-selected={selected}
          tabIndex={selected ? 0 : -1}
          title={name}
          onMouseDown={noAutoscroll}
          onMouseUp={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            onClose();
          }}
          onClick={() => selectTab(owner, tab.id)}
          onKeyDown={(event) => {
            if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
            event.preventDefault();
            const to = index + (event.key === "ArrowLeft" ? -1 : 1);
            if (to >= 0 && to <= last) moveTab(owner, tab.id, to);
          }}
          className={BUTTON}
        >
          {tab.kind === "new" ? <Globe className="size-icon-sm shrink-0" /> : <Dock className="size-icon-sm shrink-0" />}
          <span className={TITLE}>{name}</span>
        </button>
        <button type="button" aria-label={`Close ${name} tab`} onClick={onClose} className={CLOSE(selected)}>
          <X className="size-icon-xs" />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <TabMenuItems owner={owner} id={tab.id} order={order} onClose={onClose} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Keeps a removed tab only for its closing slide. */
function useTabPresence(tabs: readonly Tab[]) {
  const [state, setState] = useState({ source: tabs, tabs, closing: new Set<string>() });
  if (state.source !== tabs) {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const shown = [...tabs];
    const closing = new Set<string>();
    if (!reduced) {
      state.tabs.forEach((tab, index) => {
        if (!tabs.some((current) => current.id === tab.id)) {
          shown.splice(Math.min(index, shown.length), 0, tab);
          closing.add(tab.id);
        }
      });
    }
    setState({ source: tabs, tabs: shown, closing });
  }
  useEffect(() => {
    if (!state.closing.size) return;
    const timer = setTimeout(() => setState((now) => ({ source: now.source, tabs: now.source, closing: new Set<string>() })), CLOSING_MS);
    return () => clearTimeout(timer);
  }, [state]);
  return state;
}

/** Keeps the tabs' widths after a close, so the next × comes under the pointer. Let go once the pointer has been away a moment, on a key or a scroll, or when the window loses focus. */
function useCloseLock(alone: boolean) {
  const [count, setCount] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const release = useCallback(() => {
    clearTimeout(timer.current);
    setCount(null);
  }, []);
  const locked = count !== null;
  useEffect(() => {
    if (!locked) return;
    window.addEventListener("keydown", release, true);
    window.addEventListener("wheel", release, true);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", release, true);
      window.removeEventListener("wheel", release, true);
      window.removeEventListener("blur", release);
    };
  }, [locked, release]);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (alone && locked) setCount(null);
  return {
    count,
    release,
    hold: (current: number) => setCount((held) => held ?? current),
    stay: () => clearTimeout(timer.current),
    leave: () => {
      if (!locked) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(release, CLOSE_LOCK_MS);
    },
  };
}

/**
 * The top of every chat, session and Home, the same bar for all of them [D360]: the Chat tab first, then the tabs it
 * opened, "+", and at the end the toolbar. Click shows, drag reorders, middle-click or Delete closes. It takes the
 * title bar's place, so the title, rename and ⋯ live on the Chat tab.
 */
export function TabBar({ owner, row, offline }: { owner: string; row?: SessionRow | undefined; offline: boolean }): ReactNode {
  const now = useTabs(owner);
  const { tabs, active } = now;
  useTabsFromRust(owner);
  const archived = Boolean(row?.archived);
  useTabKeys(owner, archived);
  const presence = useTabPresence(tabs);
  const lock = useCloseLock(presence.tabs.length === 0);
  const order = tabOrder(now);
  const strip = useRef<HTMLDivElement>(null);

  // ⌘W closes the tab in front, or leaves the session from its Chat tab. Home's Chat tab has nothing to close, so main closes the window.
  const closes = !(owner === HOME && active === CHAT);
  useEffect(() => window.brigadier?.closesTab(closes), [closes]);
  useEffect(() => () => window.brigadier?.closesTab(false), []);
  useEffect(
    () =>
      window.brigadier?.onMenu((command) => {
        if (command !== "close-tab" || blocked()) return;
        const front = tabsOf(owner).active;
        if (front === CHAT) leave(row);
        else closeTab(owner, front);
      }),
    [owner, row],
  );

  // The tab in front stays in view as the strip's room changes and as the tabs finish growing or shrinking.
  const count = tabs.length;
  useEffect(() => {
    const list = strip.current;
    if (!list || count === 0) return;
    const reveal = () => list.querySelector(`[data-tab-id="${CSS.escape(active)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    list.addEventListener("transitionend", reveal);
    return () => {
      observer.disconnect();
      list.removeEventListener("transitionend", reveal);
    };
  }, [active, count]);

  // The rule before the toolbar shows once the tabs fill the bar.
  const [gap, setGap] = useState<HTMLDivElement | null>(null);
  const [full, setFull] = useState(false);
  useLayoutEffect(() => {
    if (!gap) return;
    const measure = () => setFull(gap.getBoundingClientRect().width < 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(gap);
    return () => observer.disconnect();
  }, [gap]);

  const close = (id: string) => {
    // Only while they fill the bar: at full width the next × slides under the pointer anyway.
    if (full) lock.hold(tabs.length + 1);
    closeTab(owner, id);
  };
  const onKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tab") return;
    const list = event.currentTarget;
    const focus = (id: string) => requestAnimationFrame(() => list.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"] [role="tab"]`)?.focus());
    if (event.key === "Backspace" || event.key === "Delete") {
      const id = event.target.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId;
      if (!id || id === CHAT) return;
      event.preventDefault();
      closeTab(owner, id);
      return focus(tabsOf(owner).active);
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const at = order.indexOf(active);
    const forward = (event.key === "ArrowRight") !== (getComputedStyle(list).direction === "rtl");
    const next = event.key === "Home" ? 0 : event.key === "End" ? order.length - 1 : (at + (forward ? 1 : -1) + order.length) % order.length;
    selectTab(owner, order[next]!);
    focus(order[next]!);
  };

  return (
    <header data-slot="session-tabs" className="app-drag titlebar-clear session-tab-bar flex h-titlebar shrink-0 items-center gap-1 pe-1">
      <div role="tablist" aria-label="Tabs" tabIndex={-1} data-count={lock.count ?? tabs.length + 1} className="session-tab-list flex min-w-0 items-center gap-0.5" onPointerEnter={lock.stay} onPointerLeave={lock.leave} onKeyDown={onKeys}>
        {row ? <ChatTab owner={owner} row={row} active={active === CHAT} separator={active !== CHAT && tabs[0]?.id !== active} order={order} /> : <BlankChatTab owner={owner} active={active === CHAT} separator={active !== CHAT && tabs[0]?.id !== active} />}
        <div ref={strip} className="hide-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {/* shortcut: a dragged tab can drift up and down too, dnd-kit's axis lock isn't a direct dependency; add it if that looks wrong. */}
          <DragDropProvider
            sensors={[PointerSensor]}
            onDragEnd={({ operation, canceled }) => {
              const { source } = operation;
              if (!canceled && isSortable(source) && source.index !== source.initialIndex) moveTab(owner, String(source.id), source.index);
            }}
          >
            {presence.tabs.map((tab) => {
              const index = tabs.findIndex((each) => each.id === tab.id);
              const selected = tab.id === active;
              return <OtherTab key={tab.id} owner={owner} tab={tab} index={Math.max(index, 0)} last={tabs.length - 1} selected={selected} separator={!selected && index < tabs.length - 1 && tabs[index + 1]?.id !== active} closing={presence.closing.has(tab.id)} order={order} onClose={() => close(tab.id)} />;
            })}
          </DragDropProvider>
        </div>
      </div>
      <TooltipIconButton look="toolbar" tooltip="New tab" shortcut="⌘T" className="app-no-drag ms-0.5" onClick={() => { lock.release(); openTab(owner, "new"); }}>
        <Plus />
      </TooltipIconButton>
      {offline && (
        <Badge variant="warning" role="status" className="shrink-0">
          Reconnecting…
        </Badge>
      )}
      <div ref={setGap} className="min-w-0 flex-1 self-stretch" />
      <span aria-hidden data-hidden={!full || undefined} className="mx-0.5 h-4 w-px shrink-0 bg-fill transition-opacity data-hidden:opacity-0 motion-reduce:transition-none" />
      <Toolbar owner={owner} archived={archived} />
    </header>
  );
}
