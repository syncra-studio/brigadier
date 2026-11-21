import { type ReactNode, type Ref, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { Popover } from "@base-ui/react/popover";

import { cx } from "../components/cx";
import { tokenMs } from "../components/tooltip";
import { threadSource, useDaemon } from "../daemon";
import { useStart } from "../home/start";
import { BackgroundCard } from "../panel/background";
import { AttachmentsCard, type CardFile, ChangesCard, FolderChanges, PlanCard, summaryReady, type TouchedRepo } from "../panel/card";
import { PrsCard } from "../panel/card-prs";
import { SourcesCard } from "../panel/card-sources";
import { pickRepo, useRepoPick } from "../panel/git";
import { daemonRun } from "../session/composer";
import { usePanelMemory } from "../panel/memory";
import { openPr, openReview } from "../panel/open";
import { openLink } from "../browser/links";
import { useSource } from "../panel/source/view";
import { useSettings } from "../settings/api";
import { WorkersCard } from "../workers/live";
import { SubagentsCard } from "../workers/subagents";
import { useHasPanel } from "./right-panel";
import { CHAT, HOME, openAttachment, useTabs } from "./tab-store";

/*
 * The summary card [D132–D137]: pinned at the thread pane's top end, 8 from its edges.
 * Where the pane has room beside the thread's column it sits there; with less, the column moves aside for it, keeping
 * its width; below a 1096 pane it opens over the thread only when asked, and a click outside closes it.
 */

type Layout = "beside" | "shift" | "float";

// In rem: a pane under 68.5rem (1096px) opens the card as a popover; where the column's side has under
// 28.875rem (462px: the card's 308 and the column's 154 move) the column moves aside.
const POPOVER_BELOW = 68.5;
const SHIFT_BELOW = 28.875;

function layoutOf(width: number, full: boolean): Layout {
  const root = getComputedStyle(document.documentElement);
  const rem = Number.parseFloat(root.fontSize);
  const column = full ? width : Number.parseFloat(root.getPropertyValue("--container-reading")) * rem;
  if (width < POPOVER_BELOW * rem) return "float";
  return (width - column) / 2 < SHIFT_BELOW * rem ? "shift" : "beside";
}

/**
 * The side panels easing beside the pane (sidebar-motion): how much room they'll still give it (`left`) and when their
 * easing began. A fold lays the card out for where it ends from its start, and what that moves starts with the panel,
 * so the column and the card move with it as one, never jump midway or trail it [D45, D49, D51].
 */
function fold(pane: Element) {
  let left = 0;
  let start: CSSNumberish | null = null;
  for (const panel of document.querySelectorAll(".sidebar-motion")) {
    // A panel's own inner card eases inside it, clipped: only the outermost one takes the pane's room.
    if (panel.contains(pane) || panel.parentElement?.closest(".sidebar-motion")) continue;
    const easing = panel.getAnimations().find((each) => each instanceof CSSTransition && each.transitionProperty === "width");
    const to = easing?.effect instanceof KeyframeEffect ? easing.effect.getKeyframes().at(-1)?.width : undefined;
    if (typeof to !== "string") continue;
    left += panel.getBoundingClientRect().width - Number.parseFloat(to);
    start = easing?.startTime ?? start;
  }
  return { left, start };
}

/** Per owner: `floating`, shown over the thread where it floats. Pinned is one app-wide show or hide, on until hidden,
 * kept across restarts [D134]. */
type Card = { pinned: boolean; floating: boolean; layout: Layout | null };
const PINNED = "summary-pinned";
let OPENED: Card = { pinned: localStorage.getItem(PINNED) !== "false", floating: false, layout: null };
const cards = new Map<string, Card>();
const listeners = new Set<() => void>();
function setPinned(pinned: boolean) {
  OPENED = { ...OPENED, pinned };
  localStorage.setItem(PINNED, String(pinned));
  for (const [owner, card] of cards) cards.set(owner, { ...card, pinned });
  for (const listener of listeners) listener();
}

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

const toggle = (owner: string) => {
  const card = cardOf(owner);
  if (card.layout === "float") setCard(owner, { floating: !card.floating });
  else setPinned(!card.pinned);
};

/** The toggle's state and click: it pins and unpins the card, or where it floats, opens it over the thread. */
export function useCardToggle(owner: string) {
  return { shown: visible(useCard(owner)), toggle: () => toggle(owner) };
}

/** ⌘K's and the app menu's Toggle summary [D133]: for the session in front. */
export function toggleSummary() {
  const { hash } = window.location;
  if (hash.startsWith("#thread/")) toggle(decodeURIComponent(hash.slice("#thread/".length)));
}
window.brigadier?.onMenu((command) => command === "toggle-summary" && toggleSummary());

// The card itself, pinned or floating: 300 wide, radius 16, its edge and faint shadow [D136].
const SURFACE = "pointer-events-auto flex w-75 max-w-full min-w-0 shrink-0 flex-col overflow-hidden rounded-menu bg-popover p-3 shadow-summary";

/** The card's surface, shrinking and fading in and out where it sits, inside the pane [D63, D67]; `shown` is all it's told. */
export function SummaryCard({ shown, settled = true, surface, children }: { shown: boolean; settled?: boolean; surface?: Ref<HTMLDivElement>; children?: ReactNode }) {
  return (
    // Over the thread's top fade (z-10).
    <div className="pointer-events-none absolute inset-y-0 end-0 z-20 flex max-w-full flex-col">
      <aside
        aria-label="Context"
        aria-hidden={!shown || undefined}
        className={cx(
          // 8 from the pane's top and end, a right panel's edge too [D136].
          "pointer-events-none flex max-h-full min-h-0 w-77 max-w-full flex-col overflow-y-auto pe-2 pt-2 pb-2",
          // Hidden in a pane that floats it as soon as the pane is measured, with no render between (the old app's). Shown or
          // hidden, it slides in from the right and fades, cut at the pane's end [D137].
          shown ? "summary-floats:invisible summary-floats:translate-x-4 summary-floats:opacity-0" : "invisible translate-x-4 opacity-0",
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
 * The card where it floats, a popover: over the thread at the pane's top end, at most as tall as the room
 * left; it fades in and out (menu-motion). Its toggle, Escape or a click outside closes it [D135].
 */
function FloatingCard({ open, onClose, surface }: { open: boolean; onClose: () => void; surface: Ref<HTMLDivElement> }) {
  // The pane's whole width, so the card follows the pane's end as the pane narrows.
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={setAnchor} className="pointer-events-none absolute inset-x-0 top-0 h-0" />
      {/* Focus is on the card, so its own Escape closes it; so does a click outside, but on the toggle, whose click does. */}
      <Popover.Root
        open={open}
        onOpenChange={(next, details) => !next && !(details.event?.target instanceof Element && details.event.target.closest("[data-summary-toggle]")) && onClose()}
      >
        <Popover.Portal>
          {/* Over the thread, under the toasts and its own menus (z-popup), which come before it in the page. Never flipped
              to the pane's start: it hangs from the pane's end, shifted in only where the pane is narrower than it. */}
          <Popover.Positioner className="z-20" anchor={anchor} side="bottom" align="end" sideOffset={0} collisionPadding={0} collisionAvoidance={{ side: "none", align: "shift" }}>
            <Popover.Popup
              ref={popup}
              // The card itself takes the focus, not its first button, whose tip would open with it; a dialog the card
              // opened before it floated keeps it.
              initialFocus={() => (document.activeElement?.closest('[role="dialog"], [role="alertdialog"]') ? false : popup.current)}
              aria-label="Context"
              // The pinned card's own room (SummaryCard's aside), so it keeps the same gap to the right panel [D59]; below, room for its shadow.
              className="pointer-events-none flex max-h-available w-77 max-w-available flex-col overflow-y-auto pe-2 pt-2 pb-2 outline-none menu-motion"
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
  // The first layout lands before anything eases, so a thread opens already in place. Kept per owner, so the render
  // that switches sessions already has the easing off: the old session's room going doesn't start easing the shared
  // pane's column out and back before the next session's lands [D423].
  const [settledFor, setSettledFor] = useState<string | null>(null);
  const settled = settledFor === owner;
  const has = room;
  // Full width: the reading column fills the pane, which then always moves it aside for the card [D914, D915].
  const full = useSettings().value?.thread_width === "full";

  useLayoutEffect(() => {
    const element = pane.current;
    if (!has || !element) return;
    let paneWidth = -1;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.borderBoxSize[0]?.inlineSize;
      // Only the width lays the card out: a height-only resize leaves it as it was.
      if (width === undefined || width === paneWidth) return;
      paneWidth = width;
      const before = cardOf(owner);
      const sliding = fold(element);
      const layout = layoutOf(width + sliding.left, full);
      const changed = element.dataset.summary !== layout;
      // On the element at once, for CSS: the column's move and the card's hiding land in this frame, not the next.
      element.dataset.summary = layout;
      // Seen a frame or two into a fold: the easings that starts (just made, not begun) run from the panel's start.
      if (changed && sliding.start !== null) {
        for (const each of element.getAnimations({ subtree: true })) if (each instanceof CSSTransition && each.startTime === null) each.startTime = sliding.start;
      }
      // Where it floats it waits behind its toggle, never covering the thread by itself [D135].
      if (layout !== before.layout) setCard(owner, { layout, floating: false });
      if (!frame) frame = requestAnimationFrame(() => setSettledFor(owner));
    });
    observer.observe(element, { box: "border-box" });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      delete element.dataset.summary;
      setSettledFor(null);
      setCard(owner, { layout: null, floating: false });
    };
  }, [has, owner, full]);

  // Escape closes it where it floats; a menu or dialog with the focus takes its own Escape first. Captured, as an
  // open popup elsewhere stops the key's way up.
  const floating = state.layout === "float" && state.floating;
  useEffect(() => {
    if (!floating) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.activeElement?.closest('[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]')) return;
      setCard(owner, { floating: false });
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
        // As the old app: the reading column glides aside, narrowing, and back, with the card and a fold as one.
        "reading-column:summary-column summary-shift:summary-room",
        full && "reading-full",
        settled && "summary-shift-motion",
      )}
    >
      {children}
      {/* Keyed by its session: what it holds carries across layouts, never to another session. */}
      {has && content && createPortal(card, holder, owner)}
      {card !== null && state.layout === "float" && (
        <FloatingCard open={state.floating} onClose={() => setCard(owner, { floating: false })} surface={toFloat} />
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
  // The watch's kept PRs [D1009], the session row's where the read has none; a folder chat's, each with its repo's name.
  const kept = shown.kept ?? rows?.find((row) => row.id === owner)?.prs ?? undefined;
  const prs = folderChat ? (touched ?? []).flatMap((repo) => (repo.kept?.prs ?? []).map((pr) => ({ ...pr, repo: repo.name }))) : (shown.prs ?? kept?.prs ?? []);
  // Not drawn until its data is in: no skeleton first. In this order [D128].
  const card = has && (folderChat ? touched !== null : summaryReady(shown)) ? (
    <>
      {folderChat ? (
        <FolderChanges repos={touched ?? []} onReview={(repo) => (pickRepo(owner, repo), openReview(owner))} />
      ) : (
        <ChangesCard data={shown} project={project} ops={ops} nowMs={Date.now()} onReview={() => openReview(owner)} owner={owner} prs={prs} onViewPr={(pr) => openPr(owner, pr)} />
      )}
      {/* shortcut: a folder chat's repo PR opens on its host, not the Pull requests tab; carry the repo target there when asked. */}
      <PrsCard
        owner={folderChat ? null : owner}
        prs={prs}
        kept={folderChat ? null : kept}
        nowMs={Date.now()}
        offline={shown.offline}
        onPr={(pr) => (folderChat ? pr.url && openLink(pr.url) : openPr(owner, pr))}
      />
      <PlanCard owner={owner} />
      <WorkersCard owner={owner} />
      <SubagentsCard owner={owner} />
      <BackgroundCard owner={owner} />
      <SourcesCard owner={owner} />
      <AttachmentsCard files={files} onOpen={(file, label) => openAttachment(owner, file.id, label)} />
    </>
  ) : null;
  return (
    <SummaryPane owner={owner} card={card} room={has}>
      {children}
    </SummaryPane>
  );
}
