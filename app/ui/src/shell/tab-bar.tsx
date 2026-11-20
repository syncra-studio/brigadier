import { PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";
import { RestrictToElement } from "@dnd-kit/dom/modifiers";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { Fragment, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "../components/badge";
import { useDaemon } from "../daemon";
import { shownAddress } from "../browser/address";
import { giveTab, giveTabToChat, takeBackTab, ungroup } from "../browser/give";
import { useBrowserPage } from "../browser/pages";
import { TabProfileDot } from "../browser/profile-mark";
import { BrowserTabGroupLabel, BrowserTabIcon, BrowserYourTurn } from "../browser/tab-icon";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/context-menu";
import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenuItem, DropdownMenuSeparator } from "../components/menu";
import { baseName } from "../files/tree";
import { dropDraft, newChat } from "../home/start";
import { HOME_DRAFT } from "../session/draft";
import { Plus, X } from "../icons";
import { FileIcon } from "../icons/file-types";
import { keysOf, matches } from "../shortcuts";
import type { SessionRow } from "../sidebar/words";
import { LiveMockupTabIcon } from "../mockup/live";
import { openProject } from "../projects/page";
import { BrigadeGroupLabel, SiblingTab, useBrigadeFamily } from "./brigade-tabs";
import { BlankChatTab, BUTTON, ChatTab, CLOSE, HouseTab, leave, LOOK, noAutoscroll, Shape, TAB, TabMenuItems, TITLE } from "./chat-tab";
import { useNoteTitle } from "./note-tab";
import { HOUSE, useTabGlide } from "./tab-glide";
import { useTabKeys } from "./tab-keys";
import { CHAT, closeTab, familyOrder, HOME, homeProject, justOpened, keepTab, moveTab, openTab, pageKey, selectTab, setCurrent, setPlace, SIBLING, type Tab, TAB_KINDS, tabOrder, tabsOf, useCurrent, useTabs, useTabsFromRust, useTabsProject, useTabsRead } from "./tab-store";
import { blocked } from "./titlebar";
import { Toolbar } from "./toolbar";

/** The closing slide, --duration-session-tab: as long as the others take to grow, as Chrome's. */
const CLOSING_MS = 200;

// The titlebar row: across the window's top from its start edge, everything on its middle line, the front
// tab down to its foot where the frame starts [D48 D823 D832].
const BAR = "app-drag titlebar-clear fixed start-0 end-2 top-0 flex h-tab-bar items-center gap-2 pe-2 win:pe-caption";
// A press is a click until it moves: a drag that started on the press would take the click.
const SENSORS = [PointerSensor.configure({ activationConstraints: [new PointerActivationConstraints.Distance({ value: 5 })] })];
/** Whether the tab at `at` begins an agent's tab group: the first of the tabs side by side one agent drives [D793]. */
const leadsGroup = (list: readonly Tab[], at: number) => list[at].kind === "browser" && Boolean(list[at].driver) && list[at - 1]?.driver !== list[at].driver;

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
function OtherTab({ owner, tab, index, last, selected, separator, closing, entering, order, onClose }: { owner: string; tab: Tab; index: number; last: number; selected: boolean; separator: boolean; closing: boolean; entering: boolean; order: string[]; onClose: () => void }) {
  const { ref, handleRef } = useSortable({ id: tab.id, index, disabled: closing });
  // It grows in once: a node moved in the DOM (a drag, a drop) would otherwise replay it [D432].
  const [fresh, setFresh] = useState(() => justOpened(tab.id) || entering);
  const note = useNoteTitle(tab.kind === "note" ? (tab.target ?? "") : "");
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
            data-separator={separator || undefined}
            data-closing={closing || undefined}
            aria-hidden={closing || undefined}
            inert={closing}
            data-active={selected || undefined}
            data-agent-group={(tab.kind === "browser" && tab.driver) || undefined}
            className={cx(TAB, LOOK(selected))}
          />
        }
      >
        <Shape />
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
          className={cx(BUTTON, "pe-7")}
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
        {tab.kind === "browser" && !owner.startsWith(HOME_DRAFT) && (
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

/** Keeps a removed tab only for its closing slide; one that wasn't there before grows in, as another set's tabs do
 *  when Home changes project [D836]. */
function useTabPresence(tabs: readonly Tab[]) {
  const [state, setState] = useState({ source: tabs, tabs, closing: new Set<string>(), entering: new Set<string>() });
  if (state.source !== tabs) {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const shown = [...tabs];
    const closing = new Set<string>();
    const entering = new Set(tabs.filter((tab) => !state.tabs.some((before) => before.id === tab.id)).map((tab) => tab.id));
    if (!reduced) {
      state.tabs.forEach((tab, index) => {
        if (!tabs.some((current) => current.id === tab.id)) {
          shown.splice(Math.min(index, shown.length), 0, tab);
          closing.add(tab.id);
        }
      });
    }
    setState({ source: tabs, tabs: shown, closing, entering });
  }
  useEffect(() => {
    if (!state.closing.size) return;
    const timer = setTimeout(() => setState((now) => ({ ...now, tabs: now.source, closing: new Set<string>() })), CLOSING_MS);
    return () => clearTimeout(timer);
  }, [state]);
  return state;
}

/** The one bar atop every page but Settings [D360 D854]: the house, the Chat tab, the tabs it opened, "+", the toolbar.
 *  Click shows, drag reorders, middle-click or Delete closes; the title, rename and ⋯ live on the Chat tab. */
export function TabBar({ owner, row, offline, home = false }: { owner: string; row?: SessionRow | undefined; offline: boolean; home?: boolean }): ReactNode {
  const own = useTabs(owner);
  // In a project, the row is its house and the tabs of what's current there: on its page, the session last shown in it
  // or its draft (their tabs, none in front, each opening it), else the page's own, Chat-less [D849 D850 D875].
  const tabsProject = useTabsProject();
  const project = owner === HOME ? tabsProject : (row?.project ?? null);
  const current = useCurrent(home ? project : null);
  const rows = useDaemon().rows;
  const peekRow = home && own.active === CHAT && current !== HOME ? rows?.find((each) => each.id === current && !each.archived) : undefined;
  const draft = home && own.active === CHAT && current === HOME ? `${HOME}:${project}` : undefined;
  const peek = peekRow?.id ?? draft;
  const shown = peek ?? owner;
  const openPeek = () => peek && (window.location.hash = peekRow ? `#thread/${encodeURIComponent(peek)}` : "");
  const now = useTabs(shown);
  const { tabs, active } = now;
  // What's in front in the row: nothing of a session's shown on its project's page, its house is.
  const front = peek ? "" : active;
  useTabsFromRust(owner);
  useTabsFromRust(shown);
  // A session shown is current in its project, the draft as its page shows, the page's tabs as one is in front there;
  // read as the page settles, after Home's arrival put its house in front.
  // The page itself is the last place used there while its house is in front [D865 D875].
  // Home's project as it is now: the render's may be the last page's, before Home set its own [D863].
  useEffect(() => {
    const at = owner === HOME ? homeProject() : project;
    if (!at || row?.archived) return;
    const page = home && tabsOf(HOME).active === CHAT;
    const here = home ? pageKey(at) : owner;
    setPlace(at, page ? "" : here);
    if (!page) setCurrent(at, here);
  }, [owner, home, project, row?.archived, own.active]);
  const archived = Boolean(row?.archived);
  // A Brigade's family, its tab group around the Chat tab [D3108].
  const family = useBrigadeFamily(peekRow ?? row);
  const me = family.findIndex((each) => each.id === shown);
  const [folds, setFolds] = useState<ReadonlySet<string>>(new Set());
  const familyKey = `brigade:${family[0]?.id}`;
  const familyFolded = folds.has(familyKey);
  // Keys reach only the tabs that show: folded, the family's others are out of the order.
  const familyIds = useMemo(() => (familyFolded ? [] : family.map((each) => each.id)), [family, familyFolded]);
  useTabKeys(owner, archived, peek, familyIds);
  const presence = useTabPresence(tabs);
  // By the tabs now, not those still sliding shut: Home's last tab closing takes its Chat tab in the same frame, as the old app's.
  // New chat in no project with no tabs has no Chat tab, "+" at the row's end [D831]; a project's page none but a
  // session's or its draft's, "+" after its house [D824 D850 D875].
  const bare = owner === HOME && !home && !project && tabs.length === 0;
  const chatGone = bare || (home && !peek);
  const house = owner !== HOME || project !== null;
  const houseActive = home && own.active === CHAT;
  const openHouse = () => (owner === HOME && selectTab(HOME, CHAT), project ? openProject(project) : newChat());
  // On a project's page a tab of what's current opens it there, the session or the draft's page; the page's own show on it.
  const onPick = (event: ReactMouseEvent) => {
    if (home && (event.target as Element).closest('[role="tab"]:not([data-sibling])')) openPeek();
  };
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
  const header = useRef<HTMLElement>(null);
  const ghost = useRef<HTMLSpanElement>(null);
  useTabGlide(header, ghost, houseActive ? HOUSE : front);
  const list = useRef<HTMLDivElement>(null);
  // Safari's and Chrome's: a tab closed with the pointer leaves each other tab its width until the pointer leaves the
  // row, so the next tab's × comes under it, even where closing the front puts its opener in front elsewhere [D848 D3113].
  const tabsHere = () => list.current?.querySelectorAll<HTMLElement>(".session-tab") ?? [];
  const closeHere = (id: string) => {
    for (const tab of tabsHere()) tab.dataset.frozen ??= String(tab.getBoundingClientRect().width);
    closeTab(shown, id);
  };
  const thaw = () => tabsHere().forEach((tab) => delete tab.dataset.frozen);
  // ⌘W closes the tab in front, or leaves the session from its Chat tab. Home's Chat tab has nothing to close, so main closes the window.
  const closes = !(owner === HOME && own.active === CHAT);
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
  const count = tabs.length + family.length; // a Brigade's tabs scroll in the strip too
  useEffect(() => {
    const list = strip.current;
    if (!list || count === 0) return;
    const reveal = () => {
      const tab = list.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(front)}"]`);
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
  }, [front, count]);

  const onKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tab") return;
    const list = event.currentTarget;
    const focus = (id: string) => requestAnimationFrame(() => list.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"] [role="tab"]`)?.focus());
    if (matches(event.nativeEvent, "close-focused")) {
      const id = event.target.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId;
      if (!id || id === CHAT || id.startsWith(SIBLING)) return;
      event.preventDefault();
      closeTab(shown, id);
      return focus(tabsOf(shown).active);
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    // A family's other tab takes the focus only; Enter opens its session [D3108].
    const keys = familyOrder(order, familyIds, shown);
    const at = keys.indexOf(event.target.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId ?? active);
    const forward = (event.key === "ArrowRight") !== (getComputedStyle(list).direction === "rtl");
    const next = event.key === "Home" ? 0 : event.key === "End" ? keys.length - 1 : (at + (forward ? 1 : -1) + keys.length) % keys.length;
    if (!keys[next]!.startsWith(SIBLING)) selectTab(shown, keys[next]!);
    focus(keys[next]!);
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

  // A folded group shows its label alone, as Chrome's; its tab in front keeps it open. Folding the one in front opens
  // a New tab after the strip's last, as Chrome does [D894 D909]. `folds` is above, for the keys.
  const frontDriver = tabs.find((tab) => tab.id === front)?.driver;
  const folded = (driver: string | undefined) => Boolean(driver) && driver !== frontDriver && folds.has(`${shown}:${driver}`);
  const fold = (driver: string, group: readonly Tab[]) => {
    const key = `${shown}:${driver}`;
    setFolds((now) => (now.has(key) ? new Set([...now].filter((each) => each !== key)) : new Set([...now, key])));
    if (folds.has(key) || !group.some((tab) => tab.id === front)) return;
    moveTab(shown, openTab(shown, "new"), tabs.length);
  };
  // A Brigade's group folds its other sessions' tabs, never the Chat tab: no New tab takes the front, as an agent's does [D3108].
  const foldFamily = () => setFolds((now) => (now.has(familyKey) ? new Set([...now].filter((each) => each !== familyKey)) : new Set([...now, familyKey])));
  const siblings = familyFolded ? 0 : Math.max(family.length - 1, 0);
  const newTab = (
    <TooltipIconButton look="strip" tooltip="New tab" shortcut={keysOf("new-tab")[0]} className="app-no-drag session-tab-new" onClick={() => {
        openTab(shown, "new");
        openPeek();
      }}>
      <Plus />
    </TooltipIconButton>
  );
  const chat = (peekRow ?? row) ? <ChatTab owner={shown} row={(peekRow ?? row)!} active={front === CHAT} separator={front !== CHAT && ((me >= 0 && me < family.length - 1 && !familyFolded) || tabs[0]?.id !== front)} order={order} grouped={family.length > 0} /> : <BlankChatTab owner={shown} active={!home && front === CHAT} closing={chatGone} separator={!chatGone && (home || front !== CHAT) && tabs[0]?.id !== front} onClose={project ? () => dropDraft(project) : undefined} />;
  const reconnecting = offline && <Badge variant="warning" role="status" className="shrink-0">Reconnecting…</Badge>;
  // In the titlebar row across the window's top, over the sidebar too, outside the frame below [D48 D823].
  return (
    <>
      <header ref={header} data-slot="session-tabs" data-settled={settled || undefined} onPointerLeave={thaw} className={cx(BAR, "session-tab-bar")}>
        <span ref={ghost} aria-hidden hidden data-active className="session-tab-glide">
          <span className="session-tab-shape" />
        </span>
        {house && <HouseTab active={houseActive} separator={!houseActive && (chatGone ? tabs[0]?.id !== front : !(front === CHAT && !home))} onOpen={openHouse} />}
        {/* The tabs from the start, "+" right after them [D823]: the tabs' room when crowded (session-tab-list). */}
        <div className="@container flex min-w-0 flex-1 items-center gap-2 self-stretch">
          {/* The whole strip is no-drag: a drag region gets no wheel, so the gaps between tabs wouldn't scroll. */}
          <div ref={list} role="tablist" aria-label="Tabs" tabIndex={-1} data-count={tabs.length - tabs.filter((tab) => folded(tab.driver)).length + (chatGone ? 0 : 1) + siblings} data-groups={presence.tabs.filter((_, at) => leadsGroup(presence.tabs, at)).length + (family.length > 0 ? 1 : 0)} className="session-tab-list app-no-drag flex h-tab-front min-w-0 items-end self-end" onKeyDown={onKeys} onWheel={onWheel} onClick={onPick}>
            {/* A rule after Chat unless the front tab is either side of it, as the floating design's [D437 D840]. */}
            {family.length === 0 && chat}
            <div ref={strip} className="hide-scrollbar -mx-2 flex min-w-0 items-end self-stretch overflow-x-auto px-2 empty:hidden">
              {/* A Brigade's family scrolls with the tabs, its Chat tab held in view as the front one is [D3108]. */}
              {family.length > 0 && (
                <>
                  <BrigadeGroupLabel family={family} folded={familyFolded} onFold={foldFamily} />
                  {family.slice(0, Math.max(me, 0)).map((each, at) => <SiblingTab key={each.id} row={each} folded={familyFolded} separator={!(at === me - 1 && front === CHAT)} />)}
                  {chat}
                  {me >= 0 && family.slice(me + 1).map((each, at, after) => <SiblingTab key={each.id} row={each} folded={familyFolded} separator={at < after.length - 1 || tabs[0]?.id !== front} />)}
                </>
              )}
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
                    return giveTabToChat(shown, dropped.id);
                  }
                  if (canceled || !isSortable(source) || source.index === source.initialIndex) return;
                  moveTab(shown, String(source.id), source.index);
                  // Let go between two of Brigadier's, a tab of the user's joins its group; let go away from its group, an agent's is the user's again [D894 D909].
                  const after = tabsOf(shown).tabs;
                  const at = after.findIndex((each) => each.id === String(source.id));
                  const [moved, near] = [after[at], [after[at - 1], after[at + 1]]];
                  if (moved?.kind === "browser" && !moved.driver && near.every((each) => each?.driver === shown)) giveTab(shown, moved.id);
                  else if (moved?.driver && !near.some((each) => each?.driver === moved.driver) && after.some((each) => each !== moved && each.driver === moved.driver)) takeBackTab(shown, moved.id);
                }}
              >
                {presence.tabs.map((tab, at) => {
                  const index = tabs.findIndex((each) => each.id === tab.id);
                  const selected = tab.id === front;
                  const closing = presence.closing.has(tab.id);
                  // An agent's tabs side by side are its group, led by its label, as Chrome's tab groups [D793].
                  const driver = tab.driver;
                  const leads = driver && leadsGroup(presence.tabs, at);
                  const end = leads ? presence.tabs.findIndex((each, from) => from > at && each.driver !== driver) : -1;
                  const group = leads ? presence.tabs.slice(at, end < 0 ? undefined : end) : [];
                  return (
                    <Fragment key={tab.id}>
                      {leads && (
                        <ContextMenu>
                          <ContextMenuTrigger render={<span className="contents" />}>
                            <BrowserTabGroupLabel tabs={group} driver={driver} folded={folded(driver)} onFold={() => fold(driver, group)} />
                          </ContextMenuTrigger>
                          {/* As Chrome's group menu: its tabs stay open as the user's, or all close [D901]. */}
                          <ContextMenuContent>
                            <DropdownMenuItem onClick={() => ungroup(shown, driver)}>Ungroup</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => group.forEach((each) => closeHere(each.id))}>Close group</DropdownMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      )}
                      <OtherTab owner={shown} tab={tab} index={Math.max(index, 0)} last={tabs.length - 1} selected={selected} separator={!selected && !closing && tabs[index + 1]?.id !== front} closing={closing || folded(driver)} entering={presence.entering.has(tab.id)} order={order} onClose={() => closeHere(tab.id)} />
                    </Fragment>
                  );
                })}
              </DragDropProvider>
            </div>
          </div>
          {/* Home's draft with no tab of its own has no tabs, as the old app's untabbed draft: "+" slides to the end, before the toolbar [D39 D831 D836]. */}
          <span aria-hidden data-bare={bare || undefined} className="session-tab-spacer" />
          {newTab}
          {reconnecting}
        </div>
        <Toolbar owner={owner} />
      </header>
    </>
  );
}
