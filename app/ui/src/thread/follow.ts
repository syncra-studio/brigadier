/*
 * How the thread scrolls [D447, D457]. It keeps the distance from the end, not
 * the offset. A message sent here gets blank space under the end (⅔ of the view, or the view less 240px, whichever
 * is less) and glides there; the reply grows into that space, so nothing moves. While the turn works the view
 * stays put until the work outgrows it, then follows the work; an answer started that way is followed too, one
 * started in place grows into the space and on below. Within 24px of the end counts as there. Scrolling up by
 * hand stops following and gives the space up as far as it went; coming back down to the end follows again.
 */

/** Within this of the end counts as at the end. */
export const AT_END = 24;
/** Older rows load this near the top. */
export const OLDER = 64;
/** A wheel, key, scrollbar or touch counts as the user's for this long after their last scroll. */
const INTENT_MS = 1000;
/** The jump to the end: an ease-out cubic over this long. */
const JUMP_MS = 260;
/** The glide to a sent message's space: a spring with no bounce settling in this long (rate per second). */
const PLACE_MS = 500;
const PLACE_RATE = 18.5;
/** A touch moves this far before it says which way. */
const TOUCH_SLOP = 8;

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const canSnap = () => CSS.supports("container-type", "scroll-state") && CSS.supports("scroll-snap-type", "block proximity");

/** The latest turn's: still (it grows into the space), watching the work, following the work, following. */
type Mode = "still" | "watch" | "workFollow" | "follow";
/** The latest turn: done, at work (thinking, tools, notes), or answering. */
export type Phase = "idle" | "work" | "answer";
export type Way = "away" | "toward";

/** The blank space (px) under the end, in its own store so only the spacer redraws. */
export function spaceStore() {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: number) {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
export type Space = ReturnType<typeof spaceStore>;

/** Sessions just started from Home: their thread gives the first message its space and glide once it opens. */
const toPlace = new Set<string>();
export const placeOnOpen = (id: string) => void toPlace.add(id);
export const takePlace = (id: string) => toPlace.delete(id);

/** Where each session was left, while the app runs: back to it, the view is where it was. */
const left = new Map<string, { distance: number; mode: Mode; stick: boolean }>();

export class Follow {
  el: HTMLElement | null = null;
  phase: Phase = "idle";
  private mode: Mode = "still";
  /** Following the end as content grows (the scroller's own, apart from the turn's mode). */
  private stick = true;
  private intent: { way: Way; at: number } | null = null;
  /** The distance at the last scroll seen, and the offset it was seen at. */
  private last = 0;
  private top = 0;
  /** The latest turn's drawn height, from its user message to the space. */
  private tail: number | null = null;
  private placing: (() => void) | null = null;
  private jumping: (() => void) | null = null;
  private drag: { height: number; top: number } | null = null;
  private touch: { id: number; x: number; y: number } | null = null;
  private decay = 0;
  private decaying = 0;
  private height = 0;
  /** A distance to bring back once the rows are drawn (a session opened again). */
  private restore: number | null = null;

  constructor(
    readonly space: Space,
    private readonly hooks: { older(): void; changed(): void; anchor(): Element | null },
  ) {}

  /** Opened: at the end, or where the session was left. */
  open(key: string | undefined, running: boolean) {
    const was = key === undefined ? undefined : left.get(key);
    this.restore = was && was.distance > 0 ? was.distance : null;
    this.stick = was ? was.stick : true;
    this.mode = running && (was?.distance ?? 0) <= AT_END ? (this.phase === "work" ? "workFollow" : "follow") : (was?.mode ?? "still");
  }
  /** Left: remember where, without the space. */
  leave(key: string | undefined) {
    this.stopPlacing();
    this.stopJump();
    if (key !== undefined && this.el) left.set(key, { distance: Math.max(0, this.distance() - this.space.get()), mode: this.mode, stick: this.stick });
  }

  distance() {
    const el = this.el;
    return el ? Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop) : 0;
  }
  private setDistance(distance: number) {
    const el = this.el;
    if (!el) return;
    const top = Math.max(0, el.scrollHeight - el.clientHeight - distance);
    if (distance > 0) this.unsnap();
    if (el.scrollTop !== top) el.scrollTop = top;
    this.last = this.distance();
    this.top = el.scrollTop;
  }
  /** At the end, following it. */
  private toEnd() {
    this.stick = true;
    this.setDistance(0);
    this.snap();
  }
  private ceiling() {
    const view = this.el?.clientHeight ?? 0;
    return Math.round(Math.max(0, Math.min(view * (2 / 3), view - 240)));
  }
  private spacer() {
    return this.el?.querySelector("[data-spacer]") ?? null;
  }

  /** Whether more lies below the view than the space: the jump button shows. */
  shown() {
    const el = this.el;
    if (!el || el.scrollHeight <= el.clientHeight) return false;
    const end = el.querySelector("[data-end]");
    if (!end) return this.distance() > AT_END;
    const below = end.getBoundingClientRect().bottom - (this.spacer()?.getBoundingClientRect().height ?? 0) - el.getBoundingClientRect().bottom;
    return below > AT_END;
  }

  // The end snap: while following at the very end with no space, the browser keeps the view there.
  private snap() {
    const el = this.el;
    if (el && canSnap() && this.stick && this.last <= 1 && this.intent?.way !== "away" && this.space.get() === 0) el.toggleAttribute("data-end-snap", true);
  }
  private unsnap() {
    this.el?.removeAttribute("data-end-snap");
  }
  private snapping() {
    return this.el?.hasAttribute("data-end-snap") === true;
  }

  /** This window sent a message: space under the end, then a glide to it. */
  place() {
    if (!this.el) return;
    this.stopJump();
    this.hold();
    this.decay = 0;
    this.tail = null;
    this.space.set(this.ceiling());
    this.glide();
  }
  private glide() {
    const el = this.el;
    if (!el) return;
    this.stopPlacing();
    const height = el.scrollHeight;
    let frame = 0;
    let start = 0;
    let from = 0;
    let waited = 0;
    // Spring on the distance from the end, so rows measured or grown on the way don't move where it lands.
    const step = (now: number) => {
      // The space is in the scroll height once the list has measured it.
      if (!start) {
        if (el.scrollHeight === height && waited++ < 4) return (frame = requestAnimationFrame(step));
        if (reduced()) {
          this.placing = null;
          return this.setDistance(1);
        }
        start = now;
        from = this.distance() - 1;
      }
      const t = Math.min(1, (now - start) / PLACE_MS);
      const s = (t * PLACE_MS) / 1000;
      this.setDistance(t >= 1 ? 1 : 1 + from * (1 + PLACE_RATE * s) * Math.exp(-PLACE_RATE * s));
      if (t < 1 && from > 0) frame = requestAnimationFrame(step);
      else this.placing = null;
    };
    frame = requestAnimationFrame(step);
    this.placing = () => cancelAnimationFrame(frame);
  }
  /** A wheel, touch, press or key on the thread stops the glide where it is. */
  stopPlacing = () => {
    this.placing?.();
    this.placing = null;
  };
  /** Stop following: the view stays where it is. */
  private hold() {
    this.unsnap();
    this.stick = false;
    this.mode = "still";
    this.stopPlacing();
  }
  private stopJump() {
    this.jumping?.();
    this.jumping = null;
  }

  /** The jump button: follow again; while a turn runs, or the space is still there, at once, else a short glide. */
  jump(running: boolean) {
    this.mode = "follow";
    this.intent = null;
    if (running || this.space.get() > AT_END) {
      this.clear();
      return this.toEnd();
    }
    this.toBottom();
  }
  /** To the end, following it: an ease-out cubic over 260ms, ending once within 24px; at once if already near. */
  toBottom() {
    const el = this.el;
    if (!el) return;
    this.stick = true;
    this.unsnap();
    const from = this.distance();
    this.stopJump();
    if (reduced() || from <= AT_END) return this.toEnd();
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const a = Math.min(1, (now - start) / JUMP_MS);
      const top = Math.max(0, el.scrollHeight - el.clientHeight - from * (1 - a) ** 3);
      el.scrollTop = top;
      if (a < 1 && this.distance() > AT_END) return (frame = requestAnimationFrame(step));
      this.jumping = null;
      this.toEnd();
    };
    frame = requestAnimationFrame(step);
    this.jumping = () => cancelAnimationFrame(frame);
  }
  /** Away from the end, as a jump far up does: the space goes with it. */
  away() {
    this.hold();
    this.clear();
  }

  /** The space's own: gone at once, or trimmed (it only shrinks). */
  private clear() {
    this.decay = 0;
    this.space.set(0);
  }
  private trim(to: number) {
    const next = Math.max(0, Math.min(this.space.get(), Math.round(to)));
    if (next === this.space.get()) return false;
    this.space.set(next);
    return true;
  }
  /** Space wholly under the view goes. */
  private collapseIfHidden() {
    const el = this.el;
    const spacer = this.spacer();
    if (!el || !spacer || this.space.get() <= 0 || this.placing) return;
    if (spacer.getBoundingClientRect().top >= el.getBoundingClientRect().bottom - 1) this.trim(0);
  }

  /** The latest turn changed phase. */
  setPhase(next: Phase) {
    const was = this.phase;
    if (was === next) return;
    this.phase = next;
    if (this.mode === "follow") return;
    const mode = this.mode;
    if (was !== "work" && next === "work" && mode === "still") this.mode = "watch";
    if (was === "work" && next === "answer") {
      this.mode = mode === "workFollow" ? "follow" : "still";
      if (mode === "workFollow") {
        this.clear();
        this.setDistance(0);
      }
    }
    if (next === "idle") this.mode = "still";
  }

  // What the user does: which way they mean to scroll, and whether it stops following.
  intend(way: Way, strong = false) {
    const el = this.el;
    if (!el) return;
    this.stopJump();
    const more = way === "away" ? el.scrollTop > 0 : this.distance() > 0;
    if (way === "away" && more && strong && this.stick) this.hold();
    this.intent = more ? { way, at: performance.now() } : null;
    if (way === "away") {
      if (more) this.unsnap();
      else this.hooks.older();
    }
  }
  wheel = (event: WheelEvent) => {
    const el = this.el;
    if (!el || event.defaultPrevented || event.ctrlKey || event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    if (event.deltaY < 0 && inner(event, el)) return;
    this.intend(event.deltaY < 0 ? "away" : "toward", true);
  };
  key = (event: KeyboardEvent) => {
    const el = this.el;
    if (!el || event.defaultPrevented || event.repeat) return;
    const target = event.target;
    const space = event.key === " " || event.key === "Spacebar";
    if (target instanceof HTMLElement && target !== el && (target.isContentEditable || target.closest("input, select, textarea") || (space && target.closest('button, [role="button"]')))) return;
    const way: Way | null = ["ArrowUp", "Home", "PageUp"].includes(event.key) ? "away" : ["ArrowDown", "End", "PageDown"].includes(event.key) ? "toward" : space ? (event.shiftKey ? "away" : "toward") : null;
    if (!way || (way === "away" && inner(event, el))) return;
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    this.intend(way, (event.key === "PageUp" || event.key === "ArrowUp") && plain);
  };
  /** A press on the scroller itself is its scrollbar: the next scroll says which way. */
  press = (event: PointerEvent) => {
    const el = this.el;
    this.drag = null;
    this.intent = null;
    if (!el || event.pointerType !== "mouse" || event.target !== el) return;
    this.stopJump();
    this.drag = { height: el.scrollHeight, top: el.scrollTop };
    this.unsnap();
  };
  release = () => {
    if (!this.drag) return;
    this.drag = null;
    this.snap();
  };
  touchStart = (event: TouchEvent) => {
    const touch = event.touches.length === 1 ? event.touches[0]! : null;
    this.touch = touch && { id: touch.identifier, x: touch.clientX, y: touch.clientY };
  };
  touchMove = (event: TouchEvent) => {
    const touch = event.touches.length === 1 ? event.touches[0]! : null;
    const from = this.touch;
    if (!from || !touch || touch.identifier !== from.id) return void (this.touch = null);
    const x = touch.clientX - from.x;
    const y = touch.clientY - from.y;
    if (Math.max(Math.abs(x), Math.abs(y)) < TOUCH_SLOP) return;
    this.touch = null;
    if (Math.abs(y) > Math.abs(x)) this.intend(y > 0 ? "away" : "toward");
  };
  touchEnd = () => {
    this.touch = null;
  };

  /** The scroller scrolled, by anyone. */
  scroll() {
    const el = this.el;
    if (!el) return;
    const before = this.last;
    const drag = this.drag;
    if (drag) {
      this.drag = null;
      const now = this.distance();
      if (el.scrollHeight === drag.height && el.scrollTop !== drag.top && now !== before) this.intent = { way: now > before ? "away" : "toward", at: performance.now() };
    }
    const now = this.distance();
    this.last = now;
    this.top = el.scrollTop;
    const intent = this.intent;
    if (intent && performance.now() - intent.at > INTENT_MS) this.intent = null;
    else if (intent && (now > before ? "away" : now < before ? "toward" : null) === intent.way) {
      intent.at = performance.now();
      if (now > before && el.scrollTop <= OLDER) this.hooks.older();
      this.stick = now < before && now <= AT_END;
      this.byUser(now, before);
      if (now <= AT_END) this.intent = null;
    }
    if ((!intent || this.intent) && now < before) this.snap();
    // All of it fits and it's at the end: no space is needed.
    if (this.space.get() > 0 && el.scrollHeight <= el.clientHeight && now === 0) this.clear();
    this.collapseIfHidden();
    this.hooks.changed();
  }
  /** The user scrolled from `before` to `now`: the turn's mode, and the space given up as far as they went. */
  private byUser(now: number, before: number) {
    if (now <= AT_END && this.space.get() <= AT_END && before > AT_END) this.mode = "follow";
    else if (now > AT_END && this.mode === "workFollow") this.mode = "watch";
    else if (now > AT_END && this.mode === "follow") this.mode = this.phase === "work" ? "watch" : "still";
    this.stopPlacing();
    if (now === 0) return this.clear();
    if (now <= before) return;
    this.decay += now - before;
    if (this.decaying) return;
    this.decaying = requestAnimationFrame(() => {
      this.decaying = 0;
      const by = this.decay;
      this.decay = 0;
      if (this.trim(this.space.get() - by)) this.collapseIfHidden();
    });
  }

  /** Something was drawn, measured or resized: the view, the rows, the space. */
  resized() {
    const el = this.el;
    if (!el) return;
    const viewChanged = el.clientHeight !== this.height;
    this.height = el.clientHeight;
    if (this.restore !== null) return this.bringBack();
    if (viewChanged) {
      // The space fits the new view; a glide under way starts again from where it is.
      const gliding = this.placing !== null;
      this.trim(this.ceiling());
      if (gliding) this.glide();
    }
    this.grew();
    // Snapped at the end, the browser keeps it there; a snap that missed is put right here.
    if (this.snapping() && this.distance() <= 1) return this.hooks.changed();
    const now = this.distance();
    // Following stays at the end through any growth or resize (stick goes only by the user's own scrolling).
    if (this.stick && now > 0 && this.intent?.way !== "away") this.toEnd();
    // Moved by layout only: a scroll still on its way keeps the distance it started from.
    else if (el.scrollTop === this.top) this.last = now;
    this.hooks.changed();
  }
  private bringBack() {
    const want = this.restore!;
    this.setDistance(want);
    if (Math.abs(this.distance() - want) <= AT_END) this.restore = null;
  }
  /** The latest turn grew: followed, or taken from the space; the work that outgrows the view starts being followed. */
  private grew() {
    const el = this.el;
    const anchor = this.hooks.anchor();
    const spacer = this.spacer();
    if (!el || !anchor || !spacer) return void (this.tail = null);
    const tail = spacer.getBoundingClientRect().top - anchor.getBoundingClientRect().top;
    const grown = this.tail === null ? 0 : tail - this.tail;
    this.tail = tail;
    if (this.mode === "follow" || (this.mode === "workFollow" && this.phase === "work")) {
      if (this.distance() > (this.snapping() ? 1 : 0)) this.toEnd();
      return;
    }
    // Judged before the growth is taken from it: the growth that uses the space up is the one that overflows.
    const spaced = this.space.get() > AT_END;
    if (grown > 0) this.space.set(Math.max(0, this.space.get() - grown));
    if (this.mode !== "watch" || this.phase !== "work") return;
    // The turn's end and the room under it, against the view's bottom (the spacer's DOM height is still the old one).
    const end = el.querySelector("[data-end]");
    const room = end ? end.getBoundingClientRect().bottom - spacer.getBoundingClientRect().bottom : 0;
    const over = spaced ? spacer.getBoundingClientRect().top + room - el.getBoundingClientRect().bottom : el.scrollHeight - el.clientHeight;
    if (!spaced && over > grown) return;
    if (over <= 0) return;
    this.mode = "workFollow";
    this.clear();
    this.toEnd();
  }
}

/** Between the event's target and the scroller, a box that still scrolls up, or keeps its scrolling to itself. */
function inner(event: Event, el: HTMLElement): boolean {
  for (const node of event.composedPath()) {
    if (node === el) break;
    if (!(node instanceof HTMLElement)) continue;
    const style = getComputedStyle(node);
    const scrolls = style.overflowY === "auto" || style.overflowY === "scroll";
    if ((scrolls && node.scrollTop > 0) || ((scrolls || style.overflowY === "hidden") && (style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none"))) return true;
  }
  return false;
}
