import { type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { cx } from "../components/cx";
import { useDaemon } from "../daemon";
import { GitCard } from "../panel/card";
import { openPr } from "../panel/open";
import { useSource } from "../panel/source/view";
import { useHasPanel } from "./right-panel";
import { HOME } from "./tab-store";

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

// The card itself.
const SURFACE = "pointer-events-auto flex w-75 max-w-full min-w-0 shrink-0 flex-col overflow-hidden rounded-overlay bg-popover py-2.5 shadow-raised";

/** The card's surface, eased in from the pane's end and out again, as the old one; `shown` is all it's told. */
export function SummaryCard({ shown, settled = true, children }: { shown: boolean; settled?: boolean; children: ReactNode }) {
  return (
    // Over the thread's top fade (z-10).
    <div className="pointer-events-none absolute inset-y-0 end-0 z-20 flex max-w-full flex-col">
      <aside
        aria-label="Context"
        aria-hidden={!shown || undefined}
        className={cx(
          "pointer-events-none flex max-h-full min-h-0 w-81 max-w-full origin-top-right flex-col overflow-y-auto p-3",
          !shown && "invisible translate-x-full scale-80 opacity-0",
          settled && "summary-card-motion",
        )}
      >
        <div className={SURFACE}>{children}</div>
      </aside>
    </div>
  );
}

/**
 * The thread's pane, laid out for the card by its own width; with too little room beside the reading column, the
 * column moves aside for it, as the old app's did. `card` null: no card, the pane as it was.
 */
export function SummaryPane({ owner, card, children }: { owner: string; card: ReactNode | null; children: ReactNode }) {
  const pane = useRef<HTMLDivElement>(null);
  const state = useCard(owner);
  // The first layout lands before anything eases, so a thread opens already in place.
  const [settled, setSettled] = useState(false);
  const has = card !== null;

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

  const shift = has && state.layout === "shift" && state.pinned;
  return (
    <div
      ref={pane}
      className={cx(
        // Its own stacking context, so the card stays under the tabs drawn over the chat; the card leaving is cut at its end.
        "relative isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-x-clip",
        // As the old app: the reading column glides aside and takes its narrower width at once.
        shift && "reading-column:-translate-x-summary-shift reading-column:max-w-reading-beside-summary",
        settled && "motion-safe:reading-column:transition-transform motion-safe:reading-column:duration-350 motion-safe:reading-column:ease-summary-shift",
      )}
    >
      {children}
      {has && state.layout !== null && (
        <SummaryCard shown={visible(state)} settled={settled}>
          {card}
        </SummaryCard>
      )}
    </div>
  );
}

/** The mount near the thread: sessions and project chats, where Source reads the same checkout [D1014, D1039]. */
export function SummarySlot({ owner, children }: { owner: string; children: ReactNode }) {
  const has = useHasPanel(owner) && owner !== HOME;
  const { data, ops } = useSource(owner);
  const { rows, projects } = useDaemon();
  const projectId = rows?.find((row) => row.id === owner)?.project;
  const project = projects?.find((each) => each.id === projectId)?.name ?? null;
  const card = has ? <GitCard data={data} project={project} draftKey={owner} session={owner} ops={ops} nowMs={Date.now()} onPr={(number) => openPr(owner, number)} /> : null;
  return (
    <SummaryPane owner={owner} card={card}>
      {children}
    </SummaryPane>
  );
}
