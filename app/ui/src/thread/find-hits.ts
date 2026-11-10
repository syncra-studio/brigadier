// Find in the conversation's matches [D470]: where a text is in the thread's rows, drawn or not, folded or not, and in
// the rows not loaded (Rust's count), in the thread's order. find.tsx goes to them.
import type { Older } from "../daemon";
import { findIn, MAX_RESULTS, positions, words } from "./find-text";
import type { Item } from "./item";
import type { Line } from "./lines";

/** A row the list draws: a line, or the footer. */
export type Row = Line | { type: "footer"; id: string };

/** A match in a row not drawn, or in a closed fold's or group's `item`: which of its matches it is. */
export type Away = { row: string; nth: number; item?: string };
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

/** A row's own words while not drawn: its item's, or an opened group's steps'. */
export function ownWords(line: Row): string {
  if (line.type === "item") return words(line.item);
  if (line.type === "group" && line.open) return line.steps.map((step) => words(step.item)).filter(Boolean).join("\n");
  return "";
}

/** The newest `MAX_RESULTS` matches in the thread, oldest first; what each drawn row shows goes to `read`. */
export function findInThread(root: Element, rows: readonly Row[], items: readonly Item[], needle: string, textOf: (line: Row) => string, read: Map<string, { text: string; line: Row }>) {
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
    if (row) {
      const found = findIn(row, needle);
      hits.push(...found.ranges);
      more = found.more;
      read.set(line.id, { text: found.text, line });
    } else positions(textOf(line), needle).forEach((_, nth) => hits.push({ row: line.id, nth }));
    for (const item of covered(line, items)) positions(words(item), needle).forEach((_, nth) => hits.push({ row: line.id, nth, item: item.id }));
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

/** The row not loaded holding match `index` (one of the first `before`), counted from the newest. */
export function olderAt(found: Found, index: number) {
  let left = found.before - 1 - index;
  for (const match of found.older.toReversed()) {
    if (left < match.count) return match;
    left -= match.count;
  }
  return null;
}

export const rowOf = (hit: Hit) => (isRange(hit) ? (hit.startContainer.parentElement?.closest<HTMLElement>("[data-item]")?.dataset.item ?? null) : hit.row);
export function sameHit(a: Hit, b: Hit): boolean {
  if (isRange(a) && isRange(b)) return a.startContainer === b.startContainer && a.startOffset === b.startOffset;
  return !isRange(a) && !isRange(b) && a.row === b.row && a.nth === b.nth && a.item === b.item;
}

/** The first match from the view's top down. */
export function firstBelow(root: HTMLElement, rows: readonly Row[], hits: readonly Hit[]): number {
  const line = root.getBoundingClientRect().top;
  const top = [...root.querySelectorAll<HTMLElement>("[data-item]")].find((row) => row.getBoundingClientRect().bottom > line);
  const topAt = top ? rows.findIndex((row) => row.id === top.dataset.item) : -1;
  const first = hits.findIndex((hit) => (isRange(hit) ? hit.getBoundingClientRect().bottom > line : rows.findIndex((row) => row.id === hit.row) > topAt));
  return first < 0 ? 0 : first;
}

/** The "Show more" whose cut hides `range` (a long user message, a folded code block), if one does. */
export function clippedBy(range: Range): HTMLButtonElement | null {
  const clip = range.startContainer.parentElement?.closest<HTMLElement>("[data-bubble], [data-find-clip]");
  const holder = clip?.matches("[data-bubble]") ? clip.parentElement : clip?.closest("[data-look]");
  const more = holder?.querySelector<HTMLButtonElement>(':scope > button[aria-expanded="false"]');
  if (!clip || !more) return null;
  return range.getBoundingClientRect().bottom > clip.getBoundingClientRect().bottom + 1 ? more : null;
}
