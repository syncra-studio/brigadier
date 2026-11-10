// Find in the conversation's matches [D470]: where a text is in the thread's rows, drawn or not, folded or not, and in
// the rows not loaded (Rust's count), in the thread's order. find.tsx goes to them.
import type { Older } from "../daemon";
import { findIn, MAX_RESULTS, positions, words } from "./find-text";
import type { Item } from "./item";
import type { Line } from "./lines";

/** A row the list draws: a line, or the footer. */
export type Row = Line | { type: "footer"; id: string };

/**
 * A match in a row not drawn: in `item` (the row's own, an opened group's step, or one a closed fold holds, `folded`),
 * or in the row's own labels; `back` counts it from that one's last match, as drawn text and words keep the newest.
 */
export type Away = { row: string; back: number; item?: string; folded?: boolean };
export type Hit = Range | Away;
export const isRange = (hit: Hit | undefined): hit is Range => hit instanceof Range;
export type Found = { ranges: Hit[]; more: boolean; before: number; older: readonly { n: number; count: number }[] };
export const NOTHING: Found = { ranges: [], more: false, before: 0, older: [] };

/** The first item with `n` at least `n`: items come in `n` order. */
export function firstAt(items: readonly Item[], n: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((items[middle]!.n ?? 0) < n) low = middle + 1;
    else high = middle;
  }
  return low;
}

const coveredBy = new WeakMap<Row, Item[]>();
/** What a closed work fold or group holds, which the list doesn't draw. */
export function covered(line: Row, items: readonly Item[]): Item[] {
  const span = line.type === "work" && line.open === false ? line.work?.folded : line.type === "group" && !line.open ? line.item.span : undefined;
  if (!span) return [];
  let out = coveredBy.get(line);
  if (out) return out;
  const kept = line.type === "work" ? (line.work?.kept ?? []) : [];
  out = [];
  for (let at = firstAt(items, span[0]); at < items.length && (items[at]!.n ?? 0) <= span[1]; at++) {
    const item = items[at]!;
    if (!item.hidden && !kept.includes(item.n!)) out.push(item);
  }
  coveredBy.set(line, out);
  return out;
}

/** The newest `cap` matches of `needle` in `text`, as `Away`s like `base`, oldest first. */
function awayIn(text: string, needle: string, base: Omit<Away, "back">, cap: number): Away[] {
  const at = positions(text, needle);
  const count = Math.max(0, Math.min(at.length, cap));
  return Array.from({ length: count }, (_, index) => ({ ...base, back: count - 1 - index }));
}

/** The newest `MAX_RESULTS` matches in the thread, oldest first; what each drawn row shows goes to `read`. */
export function findInThread(root: Element, rows: readonly Row[], items: readonly Item[], needle: string, textOf: (line: Row) => string | undefined, read: Map<string, { text: string; line: Row }>) {
  if (needle === "") return { ranges: [] as Hit[], more: false };
  const drawn = new Map<string, Element>();
  for (const row of root.querySelectorAll<HTMLElement>("[data-item]")) drawn.set(row.dataset.item!, row);
  const newest: Hit[][] = [];
  let count = 0;
  let more = false;
  for (let index = rows.length - 1; index >= 0 && !more; index--) {
    const line = rows[index]!;
    if (line.type === "footer") continue;
    const hits: Hit[] = [];
    const row = drawn.get(line.id);
    // Only as many as can still count (one past the cap says there are more).
    const room = () => MAX_RESULTS + 1 - count - hits.length;
    if (row) {
      const found = findIn(row, needle);
      hits.push(...found.ranges);
      more = found.more;
      read.set(line.id, { text: found.text, line });
    } else if (line.type === "item") hits.push(...awayIn(textOf(line) ?? words(line.item), needle, { row: line.id, item: line.item.id }, room()));
    else if (line.type === "group" && line.open) for (const step of line.steps) hits.push(...awayIn(words(step.item), needle, { row: line.id, item: step.id }, room()));
    else hits.push(...awayIn(textOf(line) ?? "", needle, { row: line.id }, room()));
    // What a closed fold holds: newest first, as the cap keeps the newest.
    const folded: Away[][] = [];
    let held = 0;
    for (const item of covered(line, items).toReversed()) {
      if (room() - held <= 0) break;
      const away = awayIn(words(item), needle, { row: line.id, item: item.id, folded: true }, room() - held);
      folded.push(away);
      held += away.length;
    }
    hits.push(...folded.reverse().flat());
    count += hits.length;
    if (count > MAX_RESULTS) more = true;
    newest.push(hits);
  }
  const all = newest.reverse().flat();
  return { ranges: all.slice(Math.max(0, all.length - MAX_RESULTS)), more };
}

/** The thread's matches with Rust's in the rows older than `cursor` ahead of them, the newest kept past `MAX_RESULTS`. */
export function withOlder(found: { ranges: Hit[]; more: boolean }, older: { needle: string } & Extract<Older, { ok: true }> | null, needle: string, cursor: number | null): Found {
  if (!older || older.needle !== needle || needle === "" || cursor === null) return { ...found, before: 0, older: [] };
  const unloaded = older.matches.filter((match) => match.n < cursor);
  const all = unloaded.reduce((sum, match) => sum + match.count, 0);
  const before = Math.max(0, Math.min(all, MAX_RESULTS - found.ranges.length));
  return { ranges: found.ranges, more: found.more || older.more || before < all, before, older: unloaded };
}

/** The row not loaded holding match `index` (one of the first `before`), and which of its matches from its last. */
export function olderAt(found: Found, index: number) {
  let left = found.before - 1 - index;
  for (const match of found.older.toReversed()) {
    if (left < match.count) return { n: match.n, back: left };
    left -= match.count;
  }
  return null;
}

/** The item a match is in: an opened group's step, or its row's. */
export function itemOf(hit: Hit): string | null {
  if (!isRange(hit)) return hit.item ?? hit.row;
  const at = hit.startContainer.parentElement;
  return at?.closest<HTMLElement>("[data-step]")?.dataset.step ?? at?.closest<HTMLElement>("[data-item]")?.dataset.item ?? null;
}
export function sameHit(a: Hit, b: Hit): boolean {
  if (isRange(a) && isRange(b)) return a.startContainer === b.startContainer && a.startOffset === b.startOffset;
  return !isRange(a) && !isRange(b) && a.row === b.row && a.back === b.back && a.item === b.item;
}

/** The first match from the view's top down. */
export function firstBelow(root: HTMLElement, rows: readonly Row[], hits: readonly Hit[]): number {
  const line = root.getBoundingClientRect().top;
  const top = [...root.querySelectorAll<HTMLElement>("[data-item]")].find((row) => row.getBoundingClientRect().bottom > line);
  const topAt = top ? rows.findIndex((row) => row.id === top.dataset.item) : -1;
  const first = hits.findIndex((hit) => (isRange(hit) ? hit.getBoundingClientRect().bottom > line : rows.findIndex((row) => row.id === hit.row) > topAt));
  return first < 0 ? 0 : first;
}

const CLIPS = "[data-bubble], [data-find-clip]";
/** A "Show more" whose cut hides `range` (a long user message, a folded code block, one inside the other), if one does. */
export function clippedBy(range: Range): HTMLButtonElement | null {
  const bottom = range.getBoundingClientRect().bottom;
  for (let clip = range.startContainer.parentElement?.closest<HTMLElement>(CLIPS); clip; clip = clip.parentElement?.closest<HTMLElement>(CLIPS)) {
    const holder = clip.matches("[data-bubble]") ? clip.parentElement : clip.closest("[data-look]");
    const more = holder?.querySelector<HTMLButtonElement>(':scope > button[aria-expanded="false"]');
    if (more && bottom > clip.getBoundingClientRect().bottom + 1) return more;
  }
  return null;
}
