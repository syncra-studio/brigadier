// The message rail beside the thread's column: a tick per message of the user's, the old app's (D82). Hovered, a tick
// shows the message and its answer's start; clicked, it goes to the message; pressed and dragged, it scrubs; ⌥↑ ⌥↓ step.
import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { VirtualizerHandle } from "virtua";

import { cx } from "../components/cx";
import type { Item } from "./item";
import type { Line } from "./lines";

const MIN_MESSAGES = 4;
/** Free space left of the column the rail needs. */
const MIN_GUTTER_PX = 48;
const TOLERANCE_PX = 24;
const IN_VIEW_PX = 16;
/** How much a hovered tick's neighbours grow with it, by distance. */
const FISHEYE = [1, 0.7, 0.4, 0.2];
const FLASH = [{ filter: "brightness(1.14)" }, { filter: "brightness(1)" }];
const FLASH_MS = 600;
const FLASH_EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
const SCRUB_PX = 4;

const reduced = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

/** Markdown's marks dropped, runs of white space made one: enough for a preview's lines. */
function plain(text: string): string {
  return text
    .replace(/```[^\n]*\n?/g, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/** The start of the answer to message `id`: the agent's messages up to the next of the user's. */
function answerAfter(items: readonly Item[], id: string): string {
  const at = items.findIndex((item) => item.id === id);
  if (at < 0) return "";
  const parts: string[] = [];
  for (const item of items.slice(at + 1)) {
    if (item.kind !== "message") continue;
    if (item.role === "user") break;
    parts.push(item.text);
  }
  return plain(parts.join(" "));
}

const typing = (target: EventTarget | null) => target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');

export type Entry = { id: string; text: string; index: number };

export function MessageRail({ rows, items, list, scroller, box, away }: { rows: readonly Line[]; items: readonly Item[]; list: RefObject<VirtualizerHandle | null>; scroller: () => HTMLElement | null; box: RefObject<HTMLDivElement | null>; away: () => void }) {
  // Its own messages and those steered into a running turn; another session's aren't the user's.
  const entries = useMemo(
    () => rows.flatMap((line, index): Entry[] => (line.type === "item" && line.item.kind === "message" && line.item.role === "user" && line.item.origin !== "system" && line.item.origin !== "peer" ? [{ id: line.item.id, text: plain(line.item.text).slice(0, 200), index }] : [])),
    [rows],
  );
  const [inView, setInView] = useState<ReadonlySet<string>>(() => new Set());
  const [gutter, setGutter] = useState(0);
  const now = useRef(entries);
  now.current = entries;
  // The latest jump: one superseded doesn't flash.
  const jumps = useRef(0);

  // A turn is in view from its message to the next one: so a long answer keeps its message current.
  useEffect(() => {
    const el = scroller();
    const handle = list.current;
    if (!el || !handle) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const all = now.current;
      const top = el.scrollTop + IN_VIEW_PX;
      const bottom = el.scrollTop + el.clientHeight - IN_VIEW_PX;
      const end = (el.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0;
      const shown = all.filter((entry, at) => handle.getItemOffset(entry.index) < bottom && (all[at + 1] ? handle.getItemOffset(all[at + 1]!.index) : end) > top).map((entry) => entry.id);
      const next = shown.length > 0 ? shown : all.slice(-1).map((entry) => entry.id);
      setInView((was) => (was.size === next.length && next.every((id) => was.has(id)) ? was : new Set(next)));
      const column = el.querySelector("[data-footer] > div");
      const root = box.current;
      if (column && root) setGutter(column.getBoundingClientRect().left - root.getBoundingClientRect().left);
    };
    const soon = () => (frame ||= requestAnimationFrame(measure));
    measure();
    el.addEventListener("scroll", soon, { passive: true });
    const resized = new ResizeObserver(soon);
    resized.observe(el);
    if (box.current) resized.observe(box.current);
    if (el.firstElementChild) resized.observe(el.firstElementChild);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", soon);
      resized.disconnect();
    };
  }, [scroller, list, box, entries]);

  const jumpTo = async (id: string, how: { smooth: boolean; flash: boolean }) => {
    const entry = now.current.find((each) => each.id === id);
    const el = scroller();
    if (!entry || !el) return;
    const mine = ++jumps.current;
    away();
    const smooth = how.smooth && !reduced();
    // Its row's top at the view's: the row's turn gap (24px, `pt-6`) lands the message 24px under it, the old app's.
    list.current?.scrollToIndex(entry.index, { align: "start", smooth });
    if (!how.flash) return;
    // shortcut: no second landing if rows above resize on the way, as the old app's had; add it if a jump is seen missing.
    if (smooth) {
      const stop = new AbortController();
      await new Promise((resolve) => (el.addEventListener("scrollend", resolve, { signal: stop.signal }), setTimeout(resolve, 1000)));
      stop.abort();
    }
    for (let frames = 0; frames < 60 && mine === jumps.current; frames++) {
      const bubble = el.querySelector(`[data-item="${CSS.escape(id)}"] [data-bubble]`)?.parentElement;
      if (bubble) return void bubble.animate(FLASH, { duration: FLASH_MS, easing: FLASH_EASE });
      await nextFrame();
    }
  };

  // ⌥↑ and ⌥↓ go to the message before or after the one at the view's top, rail shown or not.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.isComposing || event.defaultPrevented) return;
      const way = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      const el = scroller();
      const handle = list.current;
      const inside = event.target instanceof Node && box.current?.contains(event.target);
      // A thread behind another tab (inert) leaves the keys alone.
      if (!way || !el || !handle || typing(event.target) || box.current?.closest("[inert]") || !(inside || document.activeElement === document.body)) return;
      // Row tops: a message at rest is its row's top at the view's.
      const line = el.scrollTop;
      const offsets = now.current.map((entry) => ({ id: entry.id, at: handle.getItemOffset(entry.index) }));
      // shortcut: ⌥↑ past the oldest loaded message stops there; load older pages first once long sessions need it.
      const to = way < 0 ? offsets.findLast((each) => each.at < line - TOLERANCE_PX) : offsets.find((each) => each.at > line + TOLERANCE_PX);
      if (!to) return;
      event.preventDefault();
      void jumpTo(to.id, { smooth: true, flash: true });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  if (entries.length < MIN_MESSAGES || gutter < MIN_GUTTER_PX) return null;
  return <Rail entries={entries} items={items} inView={inView} jumpTo={jumpTo} />;
}

type Hover = { index: number; top: number };

/** The ticks and the preview, given what's in view and how to go to a message (the gallery draws it alone). */
export function Rail({ entries, items, inView, jumpTo }: { entries: readonly Entry[]; items: readonly Item[]; inView: ReadonlySet<string>; jumpTo: (id: string, how: { smooth: boolean; flash: boolean }) => Promise<void> }) {
  const navRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const press = useRef<{ y: number; scrubbing: boolean; last: string | null } | null>(null);
  const scrubbed = useRef(false);

  const hoverAt = (index: number, marker: HTMLElement) => {
    const nav = navRef.current;
    if (!nav) return;
    const at = marker.getBoundingClientRect();
    setHover({ index, top: at.top + at.height / 2 - nav.getBoundingClientRect().top });
  };

  // A list longer than it shows scrolls, its ends fading (a scroll-driven animation, only then).
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const ol = listRef.current;
    if (!ol) return;
    const measure = () => setOverflows(ol.scrollHeight > ol.clientHeight + 1);
    measure();
    const resized = new ResizeObserver(measure);
    resized.observe(ol);
    const changed = new MutationObserver(measure);
    changed.observe(ol, { childList: true });
    return () => {
      resized.disconnect();
      changed.disconnect();
    };
  }, []);

  // The rail's own list keeps the messages in view in sight, unless the pointer is on it.
  const firstInView = entries.findIndex((entry) => inView.has(entry.id));
  useEffect(() => {
    const ol = listRef.current;
    const marker = ol?.children[firstInView];
    if (!ol || hover || !(marker instanceof HTMLElement)) return;
    const top = marker.offsetTop;
    if (top < ol.scrollTop || top + marker.offsetHeight > ol.scrollTop + ol.clientHeight) ol.scrollTop = top - ol.clientHeight / 2;
  }, [firstInView, hover]);

  /** The marker nearest the pointer's height, while scrubbing. */
  const markerAt = (y: number): string | null => {
    let best: { id: string; off: number } | null = null;
    for (const button of listRef.current?.querySelectorAll<HTMLElement>("[data-rail-marker]") ?? []) {
      const at = button.getBoundingClientRect();
      const off = y < at.top ? at.top - y : y > at.bottom ? y - at.bottom : 0;
      if (!best || off < best.off) best = { id: button.dataset.railMarker!, off };
    }
    return best?.id ?? null;
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLOListElement>) => {
    if (event.button === 0) press.current = { y: event.clientY, scrubbing: false, last: null };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLOListElement>) => {
    const held = press.current;
    if (!held || (event.buttons & 1) === 0) return;
    if (!held.scrubbing) {
      if (Math.abs(event.clientY - held.y) < SCRUB_PX) return;
      held.scrubbing = true;
      // The drag goes on past the rail's edges; a pointer already let go can't be captured.
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Scrubs within the rail only.
      }
    }
    const id = markerAt(event.clientY);
    if (id && id !== held.last) {
      held.last = id;
      void jumpTo(id, { smooth: false, flash: false });
    }
  };
  const onPointerEnd = () => {
    scrubbed.current = press.current?.scrubbing ?? false;
    press.current = null;
  };

  const hovered = hover ? entries[hover.index] : undefined;
  return (
    <nav ref={navRef} aria-label="User messages" data-slot="message-rail" className="absolute top-1/2 left-4 z-20 -translate-y-1/2 animate-rail-in" onPointerLeave={() => setHover(null)}>
      <ol
        ref={listRef}
        className={cx("relative max-h-rail-list touch-none overflow-y-auto hide-scrollbar", overflows && "scroll-edge-fade edge-fade-rail")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        {entries.map((entry, index) => {
          const current = inView.has(entry.id);
          const grow = hover && !reduced() ? (FISHEYE[Math.abs(index - hover.index)] ?? 0) : hover?.index === index ? 1 : 0;
          return (
            <li key={entry.id} className="flex">
              <button
                type="button"
                data-rail-marker={entry.id}
                aria-label={entry.text || "Message"}
                aria-current={current || undefined}
                className="flex h-rail-marker-height w-rail-marker cursor-pointer items-center focus:outline-none"
                onPointerEnter={(event) => hoverAt(index, event.currentTarget)}
                onFocus={(event) => hoverAt(index, event.currentTarget)}
                onBlur={() => setHover(null)}
                onClick={() => {
                  if (scrubbed.current) return void (scrubbed.current = false);
                  void jumpTo(entry.id, { smooth: true, flash: true });
                }}
              >
                <span aria-hidden data-slot="rail-line" data-grow={grow} className={cx("h-rail-line-height rounded-capsule rail-line motion-reduce:transition-none", current || grow > 0 ? "bg-rail-line-current" : "bg-rail-line")} />
              </button>
            </li>
          );
        })}
      </ol>
      {hover && hovered && <RailPreview text={hovered.text} reply={answerAfter(items, hovered.id)} top={hover.top} />}
    </nav>
  );
}

/** Beside the hovered tick: the message on one line, then the start of its answer. */
export function RailPreview({ text, reply, top }: { text: string; reply: string; top: number }) {
  return (
    <div role="tooltip" data-slot="rail-preview" data-top={top} className="pointer-events-none absolute left-full ms-2 flex w-80 -translate-y-1/2 flex-col gap-1 rounded-surface bg-popover p-2 text-sm text-foreground shadow-overlay rail-preview">
      {text || reply ? (
        <>
          {text && <p className="truncate font-medium">{text}</p>}
          {reply && <p className="line-clamp-3 text-muted-foreground">{reply}</p>}
        </>
      ) : (
        <p className="text-muted-foreground">Preview unavailable</p>
      )}
    </div>
  );
}
