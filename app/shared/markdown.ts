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

const SHELL = /^(sh|bash|zsh|shell|console)$/i;

/** Given a text's lines in turn, the language of the fence each opens or is inside, a quote's too; null outside code. */
export function fenceWalk(): (line: string) => string | null {
  let mark = "";
  let language = "";
  let depth = 0;
  return (line) => {
    const quotes = /^(?:\s*>)*/.exec(line)![0].split(">").length - 1;
    // A quote's end closes the fence in it.
    if (quotes < depth) mark = "";
    if (!mark) depth = quotes;
    // Inside a fence, a `>` past its own quote's is code.
    const fence = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(line.split(">").slice(depth).join(">"));
    if (fence && !mark) [mark, language] = [fence[1]!, fence[2]!];
    else if (fence && fence[1]!.startsWith(mark) && !fence[2]) mark = "";
    return mark ? language : null;
  };
}

/**
 * A reply's shape, repaired where agents slip, so the prompt needn't spell it out [D525, D529, D530]: a shell
 * block's `$ ` prompts go, only the first warning stays a callout, a `#` or `##` heading reads as `###`, and a
 * line that starts in bold reads plain.
 */
export function tidy(text: string): string {
  const codeAt = fenceWalk();
  let warned = false;
  return text
    .split("\n")
    .map((line) => {
      const language = codeAt(line);
      if (language !== null) return SHELL.test(language) ? line.replace(/^(\s*)\$ /, "$1") : line;
      if (/^\s*>\s*\[!(WARNING|CAUTION)\]/.test(line)) {
        if (warned) return line.replace(/\[!(WARNING|CAUTION)\]\s*/, "");
        warned = true;
        return line;
      }
      return line.replace(/^#{1,2} /, "### ").replace(/^\*\*([^*\n]+)\*\*/, "$1");
    })
    .join("\n");
}

/** A link's or image's target as a path: `file:///a%20b.png` is `/a b.png`. */
export function pathOf(url: string): string {
  const path = url.replace(/^file:(\/\/(localhost)?)?(?=\/)/i, "");
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** A reply's message card [D477]: a fenced `brigadier-message` block's JSON, which Brigadier draws as its own card. */
export type Message = { to: string; state?: string; text: string; quote?: { from: string; text: string } };
export const MESSAGE_FENCE = "brigadier-message";

const said = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const maybe = (value: unknown) => value === undefined || typeof value === "string";

/**
 * A message card's JSON as its card; null when it doesn't parse or doesn't fit, so the fence stays a code block.
 * Questions go to the question card through the agent's question tool, never a reply card [D484].
 */
export function messageOf(json: string): Message | null {
  let m: Record<string, any> | undefined;
  try {
    m = JSON.parse(json);
  } catch {
    return null;
  }
  return !!m && said(m.to) && said(m.text) && maybe(m.state) && (m.quote === undefined || (said(m.quote?.from) && said(m.quote?.text))) ? (m as Message) : null;
}

const WRITING = /^(text|txt|plain|plaintext)$/i;

/**
 * What a reply's fence draws: something to post, as it will look (`preview`) [D446]; a message card once its JSON is
 * whole and fits, its frame while it still arrives (`live`) [D477, D520]; words to paste somewhere, a `text <where>`
 * fence, in the reply's own font [D520]; else code, titled by the words after its language, a diff's file. A bare
 * `text` fence is output, logs or an error, so code [D749].
 */
export type Fence = { kind: "preview" | "writing"; title: string } | { kind: "message"; message: Message | null } | { kind: "code"; title?: string };
export function fenceOf(language: string, meta: string | null | undefined, text: string, live: boolean): Fence {
  if (language === "preview") return { kind: "preview", title: meta || "Preview" };
  const message = language === MESSAGE_FENCE && !live ? messageOf(text) : null;
  if (language === MESSAGE_FENCE && (live || message)) return { kind: "message", message };
  if (meta && WRITING.test(language)) return { kind: "writing", title: meta };
  return { kind: "code", title: meta || undefined };
}

/** A draft's first lines as one line, its markdown marks dropped, for its folded row. */
export const peek = (text: string) =>
  text
    .split("\n", 8)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d{1,9}[.)]|#{1,6}|>)\s+/, "").replace(/\*\*|__|~~|`|\[([^\]]*)\]\([^)]*\)/g, "$1").trim())
    .filter(Boolean)
    .join(" · ");

/** Over the words a message card's message answers. */
export const wroteWords = (from: string) => `${from} wrote`;

const SEG = String.raw`\.?[\w@-]+(?:\.[\w@-]+)*`;
/**
 * A word an answer may name, in its text or as a whole inline code: a PR (#12), a session's id, a path (`/abs/a.ts`,
 * `src/a.ts:12`, `docs/`), a `/` command or skill, a file's bare name (README.md).
 */
export const WORD = new RegExp(
  String.raw`(?<![\w/#.:@-])(#\d+|s(?:-[a-z0-9]+){2}|\/?(?:${SEG}\/)+(?:${SEG})?(?::\d+){0,2}|\/\w[\w:-]*(?:\.[\w-]+)*|[\w@-]+(?:\.[\w@-]+)+(?::\d+){0,2})(?![\w/@-])`,
  "g",
);

/**
 * Splits an answer's text into its words that may be refs, each a `span` with `data-ref`, which each app's RefWord draws
 * as a chip when the session knows it, else as the word. Each piece keeps its place in the source, so it still fades in.
 */
export const remarkRefs = () => (tree: MdNode) => {
  const walk = (node: MdNode) => {
    node.children = node.children?.flatMap((child): MdNode[] => {
      if (SKIP.has(child.type)) return [child];
      if (child.type !== "text") return (walk(child), [child]);
      const value = child.value ?? "";
      const base = (child.position?.end.offset ?? value.length) - value.length;
      const piece = (from: number, to: number): MdNode => ({ type: "text", value: value.slice(from, to), position: { start: { offset: base + from }, end: { offset: base + to } } });
      const out: MdNode[] = [];
      let done = 0;
      for (const match of value.matchAll(WORD)) {
        const [from, to] = [match.index, match.index + match[0].length];
        if (from > done) out.push(piece(done, from));
        out.push({ type: "ref", data: { hName: "span", hProperties: { dataRef: match[0] } }, children: [piece(from, to)] });
        done = to;
      }
      if (!out.length) return [child];
      if (done < value.length) out.push(piece(done, value.length));
      return out;
    });
  };
  walk(tree);
};
type MdNode = { type: string; value?: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: MdNode[]; data?: object };
const SKIP = new Set(["link", "linkReference", "inlineCode", "code", "html"]);

/** A link's target as a path: `file:///a%20b.png` is `/a b.png`. */
export const linkPath = (href: string) => {
  const path = href.replace(/^file:\/\//i, "");
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
};
