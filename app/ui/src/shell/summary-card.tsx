import { type ReactNode, type Ref, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { Popover } from "@base-ui/react/popover";

import { cx } from "../components/cx";
import { tokenMs } from "../components/tooltip";
import { threadSource, useDaemon } from "../daemon";
import { useStart } from "../home/start";
import { BackgroundCard } from "../panel/background";
import { AttachmentsCard, type CardFile, FolderCard, GitCard, summaryReady, type TouchedRepo } from "../panel/card";
import { pickRepo, useRepoPick } from "../panel/git";
import { daemonRun } from "../session/composer";
import { usePanelMemory } from "../panel/memory";
import { openPr, openReview } from "../panel/open";
import { useSource } from "../panel/source/view";
import { WorkersCard } from "../workers/live";
import { SubagentsCard } from "../workers/subagents";
import { useHasPanel } from "./right-panel";
import { CHAT, HOME, openAttachment, openTab, useTabs } from "./tab-store";

/*
 * The summary card [D1014, D1048], as the old app's PinnedSummary: pinned at the thread pane's top end. Where the pane
 * has room beside the thread's column it sits there; with less, the column moves aside for it; too narrow for both,
 * it floats over the thread, and only when asked, so it never covers the conversation by itself [D48]. Wave 2 owns
 * the frame and what's in it; the other Delegator wires the Context button to `useCardToggle` [D1014].
 */

type Layout = "beside" | "shift" | "float";

// The old theme's --spacing-summary-gutter-from and --spacing-summary-beside-from, in rem.
const GUTTER_FROM = 50.25;
const BESIDE_FROM = 25;

function layoutOf(width: number): Layout {
  const root = getComputedStyle(document.documentElement);
  const rem = Number.parseFloat(root.fontSize);
  const column = Number.parseFloat(root.getPropertyValue("--container-reading")) * rem;
  if (width < GUTTER_FROM * rem) return "float";
  return (width - column) / 2 < BESIDE_FROM * rem ? "shift" : "beside";
}

/** Per owner: `pinned`, the user's show or hide, which holds at every width; `floating`, shown over the thread where it floats. */
type Card = { pinned: boolean; floating: boolean; layout: Layout | null };
const OPENED: Card = { pinned: true, floating: false, layout: null };
const cards = new Map<string, Card>();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const cardOf = (owner: string) => cards.get(owner) ?? OPENED;
function setCard(owner: string, change: Partial<Card>) {
  cards.set(owner, { ...cardOf(owner), ...change });
  for (const listener of listeners) listener();
}
const useCard = (owner: string) => useSyncExternalStore(subscribe, () => cardOf(owner));
const visible = (card: Card) => (card.layout === "float" ? card.floating : card.pinned);

/** The Context button's state and click: it pins and unpins the card, or where it floats, opens it over the thread. */
export function useCardToggle(owner: string) {
  const card = useCard(owner);
  const shown = visible(card);
  return { shown, toggle: () => setCard(owner, card.layout === "float" ? { floating: !shown, pinned: !shown } : { pinned: !shown }) };
}

// The card itself, pinned or floating.
const SURFACE = "pointer-events-auto flex w-75 max-w-full min-w-0 shrink-0 flex-col overflow-hidden rounded-overlay bg-popover py-2.5 shadow-summary";

/** The card's surface, eased in from the pane's end and out again, as the old one; `shown` is all it's told. */
export function SummaryCard({ shown, settled = true, surface, children }: { shown: boolean; settled?: boolean; surface?: Ref<HTMLDivElement>; children?: ReactNode }) {
  return (
    // Over the thread's top fade (z-10).
    <div className="pointer-events-none absolute inset-y-0 end-0 z-20 flex max-w-full flex-col">
      <aside
        aria-label="Context"
        aria-hidden={!shown || undefined}
        className={cx(
          "pointer-events-none flex max-h-full min-h-0 w-81 max-w-full origin-top-right flex-col overflow-y-auto p-3",
          // Hidden in a pane that floats it as soon as the pane is measured, with no render between (the old app's).
          shown ? "summary-floats:invisible summary-floats:translate-x-full summary-floats:scale-80 summary-floats:opacity-0" : "invisible translate-x-full scale-80 opacity-0",
          settled && "summary-card-motion",
        )}
      >
        <div ref={surface} className={SURFACE}>
          {children}
        </div>
      </aside>
    </div>
  );
}

/**
 * The card where it floats (the old FloatingSummary): over the thread at the pane's top end, under the top bar, at
 * most as tall as the room left; it fades in sliding down and fades out (menu-motion). Only the Context button or
 * Escape closes it, so `open` is all it follows.
 */
function FloatingCard({ open, onClose, surface }: { open: boolean; onClose: () => void; surface: Ref<HTMLDivElement> }) {
  // The pane's whole width, so the card follows the pane's end as the pane narrows.
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={setAnchor} className="pointer-events-none absolute inset-x-0 top-0 h-0" />
      {/* Focus is on the card, so its own Escape closes it; a click elsewhere leaves it shown. */}
      <Popover.Root open={open} onOpenChange={(next, details) => !next && details.reason === "escape-key" && onClose()}>
        <Popover.Portal>
          {/* Over the thread, under the toasts and its own menus (z-popup), which come before it in the page. */}
          <Popover.Positioner className="z-20" anchor={anchor} side="bottom" align="end" sideOffset={0} collisionPadding={0}>
            <Popover.Popup
              ref={popup}
              // The card itself takes the focus, not its first button, whose tip would open with it; a dialog the card
              // opened before it floated keeps it.
              initialFocus={() => (document.activeElement?.closest('[role="dialog"], [role="alertdialog"]') ? false : popup.current)}
              aria-label="Context"
              className="pointer-events-none flex max-h-available w-81 max-w-available flex-col overflow-y-auto p-3 outline-none menu-motion"
            >
              <div ref={surface} className={SURFACE} />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}

/**
 * The thread's pane, laid out for the card by its own width; with too little room beside the reading column, the
 * column moves aside for it, as the old app's did. `card` null: no card; with `room`, its place is kept for a card on
 * its way, which then eases in where it goes, so nothing else moves; else the pane as it was.
 */
export function SummaryPane({ owner, card, room = card !== null, children }: { owner: string; card: ReactNode | null; room?: boolean; children: ReactNode }) {
  const pane = useRef<HTMLDivElement>(null);
  const state = useCard(owner);
  // The first layout lands before anything eases, so a thread opens already in place.
  const [settled, setSettled] = useState(false);
  const has = room;

  useLayoutEffect(() => {
    const element = pane.current;
    if (!has || !element) return;
    let windowWidth = innerWidth;
    let paneWidth = -1;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.borderBoxSize[0]?.inlineSize;
      // Only the width lays the card out: a height-only resize leaves it as it was.
      if (width === undefined || width === paneWidth) return;
      paneWidth = width;
      const resized = innerWidth !== windowWidth;
      windowWidth = innerWidth;
      const before = cardOf(owner);
      const layout = layoutOf(width);
      // On the element at once, for CSS: the column's move and the card's hiding land in this frame, not the next.
      element.dataset.summary = layout;
      // A shown card stays shown as the window narrows, floating; a side panel narrowing the pane is moving on to
      // it, so the card waits behind the Context button rather than cover the thread.
      if (layout === "float") {
        const floating = before.layout === "float" ? before.floating && resized : before.layout !== null && resized && before.pinned;
        if (layout !== before.layout || floating !== before.floating) setCard(owner, { layout, floating });
      } else if (layout !== before.layout) setCard(owner, { layout, floating: false });
      if (!frame) frame = requestAnimationFrame(() => setSettled(true));
    });
    observer.observe(element, { box: "border-box" });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      delete element.dataset.summary;
      // The next session's first layout lands in place too, not eased in [D423].
      setSettled(false);
      setCard(owner, { layout: null, floating: false });
    };
  }, [has, owner]);

  // Escape closes it where it floats; a menu or dialog with the focus takes its own Escape first. Captured, as an
  // open popup elsewhere stops the key's way up.
  const floating = state.layout === "float" && state.floating;
  useEffect(() => {
    if (!floating) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.activeElement?.closest('[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]')) return;
      setCard(owner, { floating: false, pinned: false });
    };
    addEventListener("keydown", onKeyDown, true);
    return () => removeEventListener("keydown", onKeyDown, true);
  }, [floating, owner]);

  // Moving on to another tab or showing or hiding the right panel closes it where it floats, rather than leave it over
  // them; coming back to the chat isn't moving on (the old FloatingSummary).
  const { active } = useTabs(owner);
  const memory = usePanelMemory();
  const place = memory.open;
  const was = useRef({ active, place });
  useEffect(() => {
    const away = place !== was.current.place || (active !== was.current.active && active !== CHAT);
    was.current = { active, place };
    if (away && cardOf(owner).floating) setCard(owner, { floating: false });
  }, [active, place, owner]);

  // One card for the pane, carried between the pinned surface and the floating one, so what it holds (an open dialog,
  // a message being edited) stays as the layout changes. It goes back to the pinned surface once the floating one has
  // gone, after its fade.
  const [holder] = useState(() => Object.assign(document.createElement("div"), { className: "contents" }));
  const pinnedSurface = useRef<HTMLDivElement | null>(null);
  const floatSurface = useRef<HTMLDivElement | null>(null);
  const toPinned = useCallback((element: HTMLDivElement | null) => {
    pinnedSurface.current = element;
    if (element && !floatSurface.current) element.append(holder);
  }, [holder]);
  const toFloat = useCallback((element: HTMLDivElement | null) => {
    floatSurface.current = element;
    (element ?? pinnedSurface.current)?.append(holder);
  }, [holder]);
  // What it shows is kept while it can be seen and through its easing out, then goes (the old PinnedSummary), so a
  // hidden card leaves no menu open.
  const shown = visible(state);
  const [content, setContent] = useState(shown);
  if (shown && !content) setContent(true);
  useEffect(() => {
    if (shown || !content) return;
    const timer = setTimeout(() => setContent(false), tokenMs("--duration-fold"));
    return () => clearTimeout(timer);
  }, [shown, content]);

  return (
    <div
      ref={pane}
      data-pinned={(has && state.pinned) || undefined}
      className={cx(
        // Its own stacking context, so the card stays under the tabs drawn over the chat; the card leaving is cut at its end.
        "relative isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-x-clip",
        // As the old app: the reading column glides aside and takes its narrower width at once. Back, it widens as it
        // glides home, so it never runs under the sidebar meanwhile (a side panel opening).
        "summary-shift:reading-column:-translate-x-summary-shift summary-shift:reading-column:max-w-reading-beside-summary",
        settled && "motion-safe:reading-column:transition-all motion-safe:reading-column:duration-350 motion-safe:reading-column:ease-summary-shift motion-safe:summary-shift:reading-column:transition-transform",
      )}
    >
      {children}
      {/* Keyed by its session: what it holds carries across layouts, never to another session. */}
      {has && content && createPortal(card, holder, owner)}
      {card !== null && state.layout === "float" && (
        <FloatingCard open={state.floating} onClose={() => setCard(owner, { floating: false, pinned: false })} surface={toFloat} />
      )}
      {has && state.layout !== null && (
        // Hidden where it floats (summary-floats), so the pane widening again eases it back in.
        <SummaryCard shown={state.pinned && card !== null} settled={settled} surface={toPinned} />
      )}
    </div>
  );
}

/** The mount near the thread: sessions and project chats, where Source reads the same checkout [D1014, D1039]. */
export function SummarySlot({ owner, children }: { owner: string; children: ReactNode }) {
  const { rows, projects } = useDaemon();
  // An archived session's worktree went with it by design: its page has Restore, its card would only say "gone" [D180].
  const has = useHasPanel(owner) && owner !== HOME && !rows?.find((row) => row.id === owner)?.archived;
  const { data, ops } = useSource(owner);
  // A start's own project until Rust's row, so the card's title is there from its first frame.
  const start = useStart(owner);
  const projectId = rows?.find((row) => row.id === owner)?.project ?? start?.project;
  const project = projects?.find((each) => each.id === projectId)?.name ?? null;
  const updated = rows?.find((row) => row.id === owner)?.updated;
  const [files, setFiles] = useState<CardFile[]>([]);
  // Read again as the session's folder changes, which is when a message's files have become the session's.
  useEffect(() => {
    if (!has) return;
    let live = true;
    void daemonRun(["attach", owner, "list"]).then((reply) => {
      const sent = (reply.files ?? []).filter((file: { sent: boolean }) => file.sent);
      if (live) setFiles(sent.map((file: CardFile) => ({ id: file.id, name: file.name, label: file.label, mime: file.mime, url: `/attachment/${owner}/${file.id}` })));
    });
    return () => {
      live = false;
    };
  }, [owner, has, updated]);
  // Until its new worktree's first read, the branch Rust named for it, so the card is whole as the session starts [D85].
  // shortcut: a branch renamed since shows its old name until that read lands; have Rust's row carry the branch if that shows.
  const session = useSyncExternalStore(threadSource.subscribe, threadSource.get);
  const making = session?.id === owner ? session.setup?.steps.find((step) => step.kind === "worktree" && step.state !== "failed") : undefined;
  const named = making?.kind === "worktree" ? making.branch : null;
  const shown = summaryReady(data) || !named ? data : { ...data, source: { checkout: "worktree" as const, branch: named, remote: null, upstream: null, ahead: 0, behind: 0, staged: [], changes: [], merging: null, rebasing: null, sinceBase: [] } };
  // A folder chat's card lists the repos it changed, read again as the session changes [D494, D544].
  // shortcut: a repo's PRs show as of the session's last change; push them with the row if they lag.
  const folderChat = projects?.find((each) => each.id === projectId)?.kind === "folder";
  const picked = useRepoPick(owner);
  const [touched, setTouched] = useState<TouchedRepo[] | null>(null);
  useEffect(() => {
    if (!has || !folderChat) return;
    let live = true;
    void daemonRun(["source", owner, "repos"]).then((reply) => {
      if (!live || !reply.ok) return;
      setTouched(reply.repos);
      // Files and Review read the first repo it changed until another is picked.
      if (!picked && reply.repos[0]) pickRepo(owner, reply.repos[0].name);
    });
    return () => {
      live = false;
    };
  }, [owner, has, folderChat, updated, picked]);
  const workers = <><WorkersCard owner={owner} /><SubagentsCard owner={owner} /><BackgroundCard owner={owner} /></>;
  // Not drawn until its data is in: no skeleton first.
  const card = has && (folderChat ? touched !== null : summaryReady(shown)) ? (
    <>
      {folderChat ? (
        <FolderCard project={project} repos={touched ?? []} onReview={(repo) => (pickRepo(owner, repo), openReview(owner))} workers={workers} />
      ) : (
        <GitCard data={shown} project={project} session={owner} ops={ops} nowMs={Date.now()} onPr={(pr) => openPr(owner, pr)} onPrs={() => openTab(owner, "pr", "list")} onReview={() => openReview(owner)} workers={workers} />
      )}
      <AttachmentsCard files={files} onOpen={(file, label) => openAttachment(owner, file.id, label)} />
    </>
  ) : null;
  return (
    <SummaryPane owner={owner} card={card} room={has}>
      {children}
    </SummaryPane>
  );
}
