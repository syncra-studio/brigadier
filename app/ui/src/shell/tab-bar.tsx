import { PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";
import { RestrictToElement } from "@dnd-kit/dom/modifiers";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { Fragment, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Badge } from "../components/badge";
import { shownAddress } from "../browser/address";
import { giveTabToChat, takeBackTab } from "../browser/give";
import { useBrowserPage } from "../browser/pages";
import { TabProfileDot } from "../browser/profile-mark";
import { BrowserTabGroupLabel, BrowserTabIcon, BrowserYourTurn } from "../browser/tab-icon";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/context-menu";
import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/menu";
import { baseName } from "../files/tree";
import { setHomeDraft } from "../home/start";
import { HOME_DRAFT } from "../session/draft";
import { Archive, Chat, DotsHorizontal, Folder, Plus, SidebarError, X } from "../icons";
import { FileIcon } from "../icons/file-types";
import { BossCrumb, BrigadeGlyph } from "../sessions/brigade";
import { showToast } from "../components/toast";
import { useMark } from "../session/turn";
import { keysOf, matches } from "../shortcuts";
import { rename } from "../sidebar/actions";
import { RenameDialog, RowMenuItems } from "../sidebar/menu";
import { RowMark } from "../sidebar/row";
import { type SessionRow, useStatusWords } from "../sidebar/words";
import { LiveMockupTabIcon } from "../mockup/live";
import { useNoteTitle } from "./note-tab";
import { useTabKeys } from "./tab-keys";
import { CHAT, closeOthers, closeRight, closeTab, HOME, justOpened, keepTab, moveTab, openTab, selectTab, type Tab, TAB_KINDS, tabOrder, tabsOf, useTabs, useTabsFromRust, useTabsRead } from "./tab-store";
import { blocked } from "./titlebar";
import { Toolbar } from "./toolbar";

/** The closing slide, --duration-session-tab: as long as the others take to grow, as Safari's. The tab itself is gone at once. */
const CLOSING_MS = 300;

// Fixed across the window's top from its start edge, as far as the page's end inset [D48].
const BAR = "app-drag titlebar-clear fixed start-0 end-surface-inset top-0 flex h-tab-bar items-center gap-2 pt-3.5 pe-1 win:pt-0 win:pe-caption";
const TAB = "session-tab @container/tab app-no-drag group/tab flex h-7 min-w-0 items-center gap-1 rounded-capsule px-1 select-none";
// The front tab's fill is session-tab's, opaque as it holds at the strip's edge.
const LOOK = (active: boolean) => (active ? "shadow-session-tab text-foreground" : "text-toolbar-foreground hover:bg-fill");
// Its icon and title centred, a title too long cut with "…"; squeezed under 88px, the icon alone, as Safari's [D52].
const BUTTON = "flex h-full min-w-0 flex-1 cursor-pointer items-center justify-center gap-1 rounded-sm px-5 focus-visible:focus-ring @max-tab-icon/tab:px-0";
const TITLE = "@max-tab-icon/tab:hidden min-w-0 truncate";
// A press is a click until it moves: a drag that started on the press would take the click.
const SENSORS = [PointerSensor.configure({ activationConstraints: [new PointerActivationConstraints.Distance({ value: 5 })] })];
// × at the tab's start under the pointer, the front tab's too, over its padding so nothing moves; none under 64px, as Safari's.
const CLOSE = "invisible absolute start-1 top-1 flex @max-tab-close/tab:hidden size-5 cursor-pointer items-center justify-center rounded-capsule opacity-tab-close group-focus-within/tab:visible group-hover/tab:visible hover:bg-fill hover:opacity-100 focus-visible:focus-ring";
/** Whether the tab at `at` begins an agent's tab group: the first of the tabs side by side one agent drives [D793]. */
const leadsGroup = (list: readonly Tab[], at: number) => list[at].kind === "browser" && Boolean(list[at].driver) && list[at - 1]?.driver !== list[at].driver;
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

/** A chat or session's first tab, never moved: its title, its state and its ⋯. It has no × [D427]; ⌘W, middle-click and Close leave it. */
function ChatTab({ owner, row, active, separator, order }: { owner: string; row: SessionRow; active: boolean; separator: boolean; order: string[] }) {
  const [renaming, setRenaming] = useState(false);
  const words = useStatusWords(row);
  const archived = Boolean(row.archived);
  // A start Rust hasn't titled yet shows no name, not "Chat", for the moment until its title lands [D102].
  const title = row.title || (row.state === "starting" ? "" : "Chat");
  const working = useMark(row, true) === "working" && !archived;
  const startRename = archived ? undefined : () => setRenaming(true);
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div data-tab-id={CHAT} data-separator={separator || undefined} data-active={active || undefined} className={cx(TAB, LOOK(active))} />}>
        <BossCrumb boss={row.boss} />
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

/** The Chat tab before there's a session to act on: Home, or a row not read yet; on a project's page, its Home tab [D819 D820]. */
function BlankChatTab({ owner, active, separator, home }: { owner: string; active: boolean; separator: boolean; home: boolean }) {
  const [Icon, title] = home ? [Folder, "Home"] : [Chat, "Chat"];
  return (
    <div data-tab-id={CHAT} data-separator={separator || undefined} data-active={active || undefined} className={cx(TAB, LOOK(active))}>
      <button type="button" role="tab" aria-selected={active} tabIndex={active ? 0 : -1} title={title} onMouseDown={noAutoscroll} onClick={() => selectTab(owner, CHAT)} className={BUTTON}>
        <Icon className="size-icon-sm shrink-0" />
        <span className={TITLE}>{title}</span>
      </button>
    </div>
  );
}

/** A file tab is named by its file, a PR tab by its number; a Review or Mockup tab keeps its kind's name, whatever it shows. */
const pathName = (tab: Tab) => (tab.target === undefined || tab.kind === "review" || tab.kind === "mockup" ? TAB_KINDS[tab.kind].name : tab.kind === "pr" ? (tab.target === "list" ? "Pull requests" : tab.target.includes("#") ? tab.target.slice(tab.target.indexOf("/") + 1).replace("#", " #") : `#${tab.target}`) : baseName(tab.target));
const nameOf = (tab: Tab) => (tab.kind === "attachment" ? (tab.target?.split("/")[1] ?? TAB_KINDS.attachment.name) : pathName(tab));

function TabIcon({ owner, tab }: { owner: string; tab: Tab }) {
  if (tab.kind === "browser") return <span className="relative flex shrink-0"><BrowserTabIcon tabId={tab.id} /><TabProfileDot owner={owner} tab={tab} /></span>;
  if ((tab.kind === "file" || tab.kind === "attachment") && tab.target !== undefined) return <FileIcon name={nameOf(tab)} size="sm" />;
  if (tab.kind === "mockup") return <LiveMockupTabIcon worker={tab.target ?? ""} />;
  const Icon = TAB_KINDS[tab.kind].icon;
  return <Icon className="size-icon-sm shrink-0" />;
}

/** A tab it opened: the kind's icon, its name and ×. Its button is the drag handle, as a button inside a sortable won't start one otherwise; Alt+←/→ moves it from the keyboard. */
function OtherTab({ owner, tab, index, last, selected, separator, closing, order, onClose }: { owner: string; tab: Tab; index: number; last: number; selected: boolean; separator: boolean; closing: boolean; order: string[]; onClose: () => void }) {
  const { ref, handleRef } = useSortable({ id: tab.id, index, disabled: closing });
  // It grows in once: a node moved in the DOM (a drag, a drop) would otherwise replay it [D432].
  const [fresh, setFresh] = useState(() => justOpened(tab.id));
  const note = useNoteTitle(owner, tab.kind === "note" ? (tab.target ?? "") : "");
  // A page is named by its title, else its site, as a browser's tab.
  const page = useBrowserPage(tab.kind === "browser" ? tab.id : "");
  const name = tab.kind === "note" ? note : tab.kind === "browser" ? page?.title || shownAddress(tab.target ?? "", false) || TAB_KINDS.browser.name : nameOf(tab);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            ref={ref}
            data-session-tab
            data-tab-id={tab.id}
            data-fresh={fresh || undefined}
            onTransitionEnd={(event) => event.target === event.currentTarget && setFresh(false)}
            data-closing={closing || undefined}
            aria-hidden={closing || undefined}
            inert={closing}
            data-separator={separator || undefined}
            data-active={selected || undefined}
            data-agent-group={(tab.kind === "browser" && tab.driver) || undefined}
            className={cx(TAB, LOOK(selected))}
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
          onDoubleClick={() => tab.preview && keepTab(owner, tab.id)}
          onKeyDown={(event) => {
            if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
            event.preventDefault();
            const to = index + (event.key === "ArrowLeft" ? -1 : 1);
            if (to >= 0 && to <= last) moveTab(owner, tab.id, to);
          }}
          className={BUTTON}
        >
          <TabIcon owner={owner} tab={tab} />
          <span className={cx(TITLE, tab.preview && "italic")}>{name}</span>
          {tab.kind === "browser" && tab.driver && <BrowserYourTurn tabId={tab.id} />}
        </button>
        <button type="button" aria-label={`Close ${name} tab`} onClick={onClose} className={CLOSE}>
          <X className="size-icon-xs" />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {tab.preview && (
          <>
            <DropdownMenuItem onClick={() => keepTab(owner, tab.id)}>Keep open</DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {tab.kind === "browser" && owner !== HOME_DRAFT && (
          <>
            {/* The session's own agent is Brigadier to the user, whichever CLI it runs [D778]. */}
            {tab.driver ? <DropdownMenuItem onClick={() => takeBackTab(owner, tab.id)}>Take back</DropdownMenuItem> : <DropdownMenuItem onClick={() => giveTabToChat(owner, tab.id)}>Give to Brigadier</DropdownMenuItem>}
            <DropdownMenuSeparator />
          </>
        )}
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

/**
 * The top of every chat, session, and Home once it has a tab, the same bar for all of them [D360]: the Chat tab first, then the tabs it
 * opened, "+", and at the end the toolbar. Click shows, drag reorders, middle-click or Delete closes. It takes the
 * title bar's place, so the title, rename and ⋯ live on the Chat tab.
 */
export function TabBar({ owner, row, offline, home = false }: { owner: string; row?: SessionRow | undefined; offline: boolean; home?: boolean }): ReactNode {
  const now = useTabs(owner);
  const { tabs, active } = now;
  useTabsFromRust(owner);
  const archived = Boolean(row?.archived);
  useTabKeys(owner, archived);
  const presence = useTabPresence(tabs);
  // By the tabs now, not those still sliding shut: Home's last tab closing takes its Chat tab in the same frame, as the old app's.
  // A project's page always shows its Home tab [D819].
  const bare = owner === HOME && tabs.length === 0 && !home;
  // What's read on opening shows at its size [D423]: nothing slides until a frame after Rust's first answer.
  const read = useTabsRead(owner);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!read) return;
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [read]);
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

  // The tab in front stays in view as the strip's room changes and as the tabs finish growing or shrinking. It holds at
  // the strip's edge (sticky), so it's measured at its own place for the moment: its place is what comes into view.
  const count = tabs.length;
  useEffect(() => {
    const list = strip.current;
    if (!list || count === 0) return;
    const reveal = () => {
      const tab = list.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(active)}"]`);
      if (!tab) return;
      tab.toggleAttribute("data-measuring", true);
      tab.scrollIntoView({ block: "nearest", inline: "nearest" });
      tab.toggleAttribute("data-measuring", false);
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    list.addEventListener("transitionend", reveal);
    return () => {
      observer.disconnect();
      list.removeEventListener("transitionend", reveal);
    };
  }, [active, count]);

  const onKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tab") return;
    const list = event.currentTarget;
    const focus = (id: string) => requestAnimationFrame(() => list.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"] [role="tab"]`)?.focus());
    if (matches(event.nativeEvent, "close-focused")) {
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

  // The wheel scrolls the strip from anywhere on the pill: the chat tab and the pill's edge move it as the tabs do,
  // and a mouse wheel's up and down move it along; a sideways swipe over the strip it already scrolls itself.
  const onWheel = (event: ReactWheelEvent) => {
    const list = strip.current;
    if (!list) return;
    const sideways = Math.abs(event.deltaX) >= Math.abs(event.deltaY);
    if (sideways && list.contains(event.target as Node)) return;
    list.scrollLeft += sideways ? event.deltaX : event.deltaY;
  };

  const newTab = (
    <TooltipIconButton look="round" tooltip="New tab" shortcut={keysOf("new-tab")[0]} className="app-no-drag" onClick={() => openTab(owner, "new")}>
      <Plus />
    </TooltipIconButton>
  );
  const reconnecting = offline && (
    <Badge variant="warning" role="status" className="shrink-0">
      Reconnecting…
    </Badge>
  );
  // Home with no tab of its own has no tab bar, as the old app's untabbed draft: "+" leads the toolbar at the end [D39].
  if (bare)
    return (
      <>
        <div aria-hidden className="h-page-top shrink-0" />
        <header data-slot="session-tabs" className={cx(BAR, "justify-end")}>
          {reconnecting}
          {newTab}
          <Toolbar owner={owner} />
        </header>
      </>
    );

  return (
    <>
      {/* The bar's room in the column; the bar itself runs across the window's top, over the sidebar too [D48]. */}
      <div aria-hidden className="h-page-top shrink-0" />
      <header data-slot="session-tabs" data-settled={settled || undefined} className={cx(BAR, "session-tab-bar")}>
        {/* The pill fills the room up to "+", the tabs sharing it as Safari's [D52]. */}
        <div className="flex min-w-0 flex-1 items-center gap-2 self-stretch">
          {/* The tabs in one glass pill [new-design]; the front tab its fill alone, 1px in on every side, so the pill has one edge.
              The whole pill is no-drag: a drag region gets no wheel, so the gaps between tabs wouldn't scroll. */}
          <div role="tablist" aria-label="Tabs" tabIndex={-1} data-count={tabs.length + 1} data-groups={presence.tabs.filter((_, at) => leadsGroup(presence.tabs, at)).length} className="session-tab-list app-no-drag flex h-7.5 min-w-0 items-center gap-0.5 rounded-capsule bg-control p-px ring-1 ring-glass-stroke ring-inset" onKeyDown={onKeys} onWheel={onWheel}>
            {row ? <ChatTab owner={owner} row={row} active={active === CHAT} separator={active !== CHAT && tabs[0]?.id !== active} order={order} /> : <BlankChatTab owner={owner} active={active === CHAT} separator={active !== CHAT && tabs[0]?.id !== active} home={home} />}
            <div ref={strip} className="hide-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto empty:hidden">
              {/* Held inside the strip, which is a tab high: it moves along the row only. */}
              <DragDropProvider
                sensors={SENSORS}
                modifiers={[RestrictToElement.configure({ element: () => strip.current })]}
                onDragEnd={({ operation, canceled }) => {
                  const { source } = operation;
                  // A browser tab let go over the composer goes to the session's agent, as its menu's Give does [D775].
                  const { x, y } = operation.position.current;
                  const dropped = tabs.find((each) => each.id === String(source?.id));
                  if (!canceled && dropped?.kind === "browser" && !dropped.driver && document.elementsFromPoint(x, y).some((each) => each.closest('[data-slot="composer-card"]'))) {
                    return giveTabToChat(owner, dropped.id);
                  }
                  if (!canceled && isSortable(source) && source.index !== source.initialIndex) moveTab(owner, String(source.id), source.index);
                }}
              >
                {presence.tabs.map((tab, at) => {
                  const index = tabs.findIndex((each) => each.id === tab.id);
                  const selected = tab.id === active;
                  const closing = presence.closing.has(tab.id);
                  // An agent's tabs side by side are its group, led by its label, as Chrome's tab groups [D793].
                  const driver = tab.driver;
                  const leads = driver && leadsGroup(presence.tabs, at);
                  const end = leads ? presence.tabs.findIndex((each, from) => from > at && each.driver !== driver) : -1;
                  const group = leads ? presence.tabs.slice(at, end < 0 ? undefined : end).map((each) => each.id) : [];
                  return (
                    <Fragment key={tab.id}>
                      {leads && <BrowserTabGroupLabel tabIds={group} driver={driver} />}
                      <OtherTab owner={owner} tab={tab} index={Math.max(index, 0)} last={tabs.length - 1} selected={selected} separator={!selected && !closing && index < tabs.length - 1 && tabs[index + 1]?.id !== active} closing={closing} order={order} onClose={() => closeTab(owner, tab.id)} />
                    </Fragment>
                  );
                })}
              </DragDropProvider>
            </div>
          </div>
          {newTab}
          {reconnecting}
        </div>
        <Toolbar owner={owner} />
      </header>
    </>
  );
}
