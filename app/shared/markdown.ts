// A reply's markdown rules both apps' renderers run (react-markdown, remark-gfm, remark-breaks): drawing stays in each.

export const textOf = (node?: Node): string => node?.value ?? (node?.children ?? []).map(textOf).join("");

/** A hast node, as far as the renderers read it. */
export type Node = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown; dataAt?: number; dataRef?: string; dataCallout?: string };
  data?: { meta?: string };
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: Node[];
};

/** GitHub's alert, a quote opening with `[!WARNING]` or its kin: the quote is marked as that callout and loses the marker [D477]. */
export const callouts = () => (tree: Node, file: { value: unknown }) => {
  const walk = (node: Node) => {
    for (const child of node.children ?? []) walk(child);
    if (node.tagName !== "blockquote") return;
    // Its first block, opening with the bracket itself: an escaped `\[` is the text it says.
    const p = node.children?.find((c) => c.type === "element");
    const first = p?.tagName === "p" ? p.children?.[0] : undefined;
    const hit = first?.type === "text" && String(file.value)[p?.position?.start.offset ?? -1] === "[" ? /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/.exec(first.value ?? "") : null;
    if (!p || !first || !hit) return;
    node.properties = { ...node.properties, dataCallout: hit[1] };
    first.value = first.value!.slice(hit[0].length);
    if (!first.value && p.children![1]?.tagName === "br") p.children!.splice(0, 2);
    // The marker alone in its paragraph: the next block is the first line, beside the icon.
    else if (!first.value && p.children!.length === 1) node.children = node.children!.filter((c) => c !== p);
  };
  walk(tree);
};

/** A callout's icon's words, a warning's or a note's. */
export const calloutLabel = (warn: boolean) => (warn ? "Warning" : "Note");
/** A callout that warns (WARNING, CAUTION) rather than notes. */
export const calloutWarns = (kind: string) => kind === "WARNING" || kind === "CAUTION";

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ITEM = /^(\d{1,9})[.)] \S/;
const BULLET = /^[-*+] \S/;

/**
 * Agents often leave a draft's fence, or an item's bullets, at column 0 under a numbered item, which ends the
 * list there. They are indented into the item before drawing [D520]: a fence always, bullets when
 * another numbered item follows, there are two or more, or the item ends with ":". shortcut: an indent added
 * mid-stream shifts that moment's fading chunk by its width, until chunks are kept by the written text.
 */
export function nestUnderItems(text: string): string {
  if (!/^\d{1,9}[.)] /m.test(text)) return text;
  const lines = text.split("\n");
  // The end (exclusive) of the fence opening at `from`, or of the text if it never closes.
  const fenceEnd = (from: number) => {
    const mark = FENCE.exec(lines[from]!)![1]!;
    let at = from + 1;
    while (at < lines.length && !new RegExp(`^ {0,3}${mark[0]}{${mark.length},}\\s*$`).test(lines[at]!)) at++;
    return Math.min(at + 1, lines.length);
  };
  for (let at = 0; at < lines.length; at++) {
    if (FENCE.test(lines[at]!)) {
      at = fenceEnd(at) - 1;
      continue;
    }
    const item = ITEM.exec(lines[at]!);
    if (!item) continue;
    // The blocks right under the item: fences and bullet runs, a blank line apart at most.
    let end = at + 1;
    let bullets = 0;
    let fences = 0;
    for (let next = end; next < lines.length; ) {
      const from = lines[next] === "" ? next + 1 : next;
      if (from < lines.length && /^(`{3,}|~{3,})/.test(lines[from]!)) {
        fences++;
        next = end = fenceEnd(from);
      } else if (from < lines.length && BULLET.test(lines[from]!)) {
        next = from;
        while (next < lines.length && (BULLET.test(lines[next]!) || /^ {2,}\S/.test(lines[next]!))) bullets += +BULLET.test(lines[next++]!);
        end = next;
      } else break;
    }
    if (end === at + 1) continue;
    const following = lines.slice(end).find((line) => line !== "");
    if (bullets && !(following !== undefined && ITEM.test(following)) && bullets < 2 && !lines[at]!.trimEnd().endsWith(":")) continue;
    const pad = " ".repeat(item[1]!.length + 2);
    for (let line = at + 1; line < end; line++) if (lines[line]) lines[line] = pad + lines[line];
    at = end - 1;
  }
  return lines.join("\n");
}
