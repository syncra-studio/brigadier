// Find in the conversation's text side (find.tsx is the bar) [D470]: what a row says, where a text is in what the
// thread shows, and the marks, through the CSS Custom Highlight API so the thread's DOM is never touched. The old
// app's ThreadFind, findWords and highlightRules [D48].
import { useSyncExternalStore } from "react";

import type { Item } from "./item";

/** Counting stops here: "250+ results". */
export const MAX_RESULTS = 250;
const MATCHES = "thread-find";
const ACTIVE_MATCH = "thread-find-active";
/** On the scroller while it holds marks: its text is selectable (theme.css). */
const FINDING = "data-thread-finding";
/** On a button holding the match gone to, whose text WebKit never marks. */
const ACTIVE_BUTTON = "data-thread-find-active";

/** What is never searched, with all it holds. */
const SKIP = ["script", "style", "textarea", "input", "select", '[contenteditable]:not([contenteditable="false"])', "[hidden]", ".sr-only"].join(", ");
/** Text in different ones of these never runs together into one match. */
const BLOCK = "p, li, pre, h1, h2, h3, h4, h5, h6, td, th, tr, blockquote, dt, dd, div, button, summary, label";

/** Lower case, code unit by code unit where lowering a character would change its length. */
export function lower(text: string): string {
  const all = text.toLowerCase();
  if (all.length === text.length) return all;
  let out = "";
  for (const unit of text.split("")) {
    const lowered = unit.toLowerCase();
    out += lowered.length === 1 ? lowered : unit;
  }
  return out;
}

/** Where `needle` (lower case) starts in `text` (lower case), each match after the last one's end. */
export function positions(text: string, needle: string): number[] {
  const out: number[] = [];
  if (needle === "") return out;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) out.push(at);
  return out;
}

const FENCE = /^\s{0,3}```/;
const INLINE_CODE = /(`+)([\s\S]*?[^`])\1(?!`)/;
const unmarkedProse = (text: string) => text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__|~~|`/g, "");

/** Markdown's marks, which an answer drawn shows without: fences, heads, quotes, list marks, links' targets, emphasis. Code keeps what it says. */
function unmarked(text: string): string {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return "";
      }
      if (fenced) return line;
      const rest = line.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "");
      // Prose and inline code by turns: [prose, ticks, code, prose, …].
      return rest
        .split(new RegExp(INLINE_CODE.source, "g"))
        .map((part, index) => (index % 3 === 0 ? unmarkedProse(part) : index % 3 === 2 ? part : ""))
        .join("");
    })
    .join("\n");
}

const wordsBy = new WeakMap<Item, string>();

/**
 * What a row says, lower case, as find reads it while the row isn't drawn: its words, not every label it draws. The
 * same fields as Rust's `thread/find.rs`, which searches the rows not loaded.
 */
export function words(item: Item): string {
  let out = wordsBy.get(item);
  if (out !== undefined) return out;
  const fields =
    item.kind === "message" ? [item.role === "assistant" ? unmarked(item.text) : item.text]
    : item.kind === "notice" ? ["text" in item ? item.text : ""]
    : item.kind === "tool" ? [item.name, (item.step ?? "other") === "other" ? "" : item.input] // another tool's row shows only its name
    : item.kind === "question" ? [item.question, item.answer]
    : item.kind === "childAgent" ? [item.title, item.answer]
    : item.kind === "fileChange" ? item.changes.map((change) => change.path)
    : [];
  out = lower(fields.filter(Boolean).join("\n"));
  wordsBy.set(item, out);
  return out;
}

/** Whether an element shows no text at all: not laid out (`display: none` here or above). */
function unseen(element: Element): boolean {
  if (typeof element.checkVisibility !== "function" || element.checkVisibility()) return false;
  return getComputedStyle(element).display !== "contents";
}

/** The text `root` shows, as find reads it, with the text nodes it is made of and where each starts. */
function textIn(root: Element): { text: string; nodes: Text[]; starts: number[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (node instanceof Text) return node.data === "" ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT;
      if (node instanceof Element && (node.matches(SKIP) || unseen(node))) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_SKIP;
    },
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  let lastBlock: Element | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text)) continue;
    const block = node.parentElement?.closest(BLOCK) ?? null;
    if (nodes.length > 0 && block !== lastBlock) text += "\n";
    lastBlock = block;
    starts.push(text.length);
    nodes.push(node);
    text += node.data;
  }
  return { text, nodes, starts };
}

/** The newest `MAX_RESULTS` matches of `needle` (lower case) in the text `root` shows, top to bottom, and that text, lower case. */
export function findIn(root: Element, needle: string): { ranges: Range[]; more: boolean; text: string } {
  if (needle === "") return { ranges: [], more: false, text: "" };
  const { text, nodes, starts } = textIn(root);
  const haystack = lower(text);
  const locate = (at: number): [Text, number] | null => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((starts[middle] ?? 0) <= at) low = middle;
      else high = middle - 1;
    }
    const node = nodes[low];
    return node ? [node, at - (starts[low] ?? 0)] : null;
  };
  const ranges: Range[] = [];
  const all = positions(haystack, needle);
  for (const at of all.slice(-MAX_RESULTS)) {
    const start = locate(at);
    const end = locate(at + needle.length - 1);
    if (!start || !end) break;
    const range = document.createRange();
    range.setStart(start[0], start[1]);
    range.setEnd(end[0], end[1] + 1);
    ranges.push(range);
  }
  return { ranges, more: all.length > MAX_RESULTS, text: haystack };
}

/** Whether `find.tsx`'s bar has a text: a folded code block draws all its lines, cut to its fold, to be found. */
const searching = new Set<object>();
const heard = new Set<() => void>();
const isSearching = () => searching.size > 0;
const subscribeSearching = (listener: () => void) => {
  heard.add(listener);
  return () => heard.delete(listener);
};
export const useFindSearching = (): boolean => useSyncExternalStore(subscribeSearching, isSearching);
/** The bar starts searching; the function returned says it stopped. */
export function startSearching(): () => void {
  const me = {};
  searching.add(me);
  for (const listener of heard) listener();
  return () => {
    searching.delete(me);
    for (const listener of heard) listener();
  };
}

/**
 * The marks' colours, on the page only while the marks are: a `::highlight()` rule in a stylesheet costs every style
 * pass, for marks that are rarely there.
 */
// A constructed sheet: the page's CSP (default-src 'self') refuses a style element made at run time.
let sheet: CSSStyleSheet | null = null;
function showColours(on: boolean): void {
  sheet ??= new CSSStyleSheet();
  const shown = document.adoptedStyleSheets.includes(sheet);
  if (on === shown) return;
  if (!on) {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((each) => each !== sheet);
    return;
  }
  sheet.replaceSync(`::highlight(${MATCHES}) { background-color: var(--color-find-match); }\n::highlight(${ACTIVE_MATCH}) { background-color: var(--color-find-match-active); }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

/** Changed in place, never swapped or dropped whole: WebKit left a replaced highlight's old marks on screen. */
function marks(name: string, priority: number): Highlight {
  let highlight = CSS.highlights.get(name);
  if (!highlight) {
    highlight = new Highlight();
    highlight.priority = priority;
    CSS.highlights.set(name, highlight);
  }
  return highlight;
}

/** Each text run painted on its own (inline code has its own padding); a button's text is ringed instead. */
function pieces(range: Range): Range[] {
  const root = range.commonAncestorContainer;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: Range[] = [];
  for (let node = root instanceof Text ? root : walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || !range.intersectsNode(node) || node.parentElement?.closest("button")) continue;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.length;
    if (start === end) continue;
    const piece = document.createRange();
    piece.setStart(node, start);
    piece.setEnd(node, end);
    out.push(piece);
  }
  return out;
}

/** Marks `ranges` in the scroller `root`, `active` over them. */
export function paint(root: HTMLElement, ranges: readonly Range[], active: Range | null): void {
  if (typeof Highlight === "undefined") return;
  root.setAttribute(FINDING, "");
  showColours(true);
  const all = marks(MATCHES, 0);
  all.clear();
  for (const range of ranges) for (const piece of pieces(range)) all.add(piece);
  const current = marks(ACTIVE_MATCH, 1);
  current.clear();
  if (active) for (const piece of pieces(active)) current.add(piece);
  const ringed = active?.startContainer.parentElement?.closest("button") ?? null;
  for (const button of root.querySelectorAll(`[${ACTIVE_BUTTON}]`)) if (button !== ringed) button.removeAttribute(ACTIVE_BUTTON);
  if (ringed && root.contains(ringed)) ringed.setAttribute(ACTIVE_BUTTON, "");
}

/** Takes the marks off, then the thread's text back to what it was. */
export function unpaint(root: HTMLElement | null): void {
  if (typeof Highlight !== "undefined") {
    for (const name of [MATCHES, ACTIVE_MATCH]) {
      CSS.highlights.get(name)?.clear();
      CSS.highlights.delete(name);
    }
  }
  showColours(false);
  if (!root) return;
  for (const button of root.querySelectorAll(`[${ACTIVE_BUTTON}]`)) button.removeAttribute(ACTIVE_BUTTON);
  root.removeAttribute(FINDING);
}

/** "2 / 7 results", "1 / 1 result", "3 / 250+ results", "0 results". */
export function findLabel(active: number, count: number, more: boolean): string {
  if (count === 0) return "0 results";
  if (more) return `${active + 1} / ${MAX_RESULTS}+ results`;
  return `${active + 1} / ${count} ${count === 1 ? "result" : "results"}`;
}
