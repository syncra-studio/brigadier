import { Fragment, memo, type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { marked } from "marked";

import { Code, Compare, Eye, Info, Terminal, Warning } from "../icons";
import { CodeBlock } from "./code";
import { Draft, replyCard, replyCardFrame, WritingCard } from "./reply-cards";
import { linkPath, RefWord, remarkRefs } from "./refs";
import { PrHoverCard } from "../pull-requests/hover-card";
import { pastedRef } from "../pull-requests/route";

// Every line break kept, as written: the user's text and the agents' answers alike [D140].
const plugins = [remarkGfm, remarkBreaks, remarkRefs];

/**
 * A reply's markdown, one top-level block at a time, so while a reply streams only its last block parses
 * and draws again. marked only finds where blocks end (whole-reply parsing is what made rendering slow);
 * react-markdown draws each block. `chip` draws a `[@](chip:n)` link as the message's n-th chip, where the user
 * put it [D2107]. The chunks a streaming reply grows by fade in [D53].
 */
export function Markdown({ text: written, keep, chip, streaming }: { text: string; keep: string; chip?: (n: number) => ReactNode; streaming?: boolean }) {
  const text = nestUnderItems(written);
  const chunks = useChunks(text);
  const tokens = marked.lexer(text);
  const tail = streaming ? tokens.findLastIndex((token) => token.type !== "space") : -1;
  let start = 0;
  // A block alone can't see link definitions in the others (nested ones too), so a block gets the ones it names,
  // and a definition still streaming redraws only the blocks that use it.
  const definitions = Object.entries(tokens.links).map(
    ([label, link]) => [`[${label}]`, `[${label}]: <${link.href}>${link.title ? ` "${link.title.replace(/"/g, '\\"')}"` : ""}`] as const,
  );
  const withDefinitions = (raw: string) => {
    // marked keys them lower-cased with runs of whitespace as one space.
    const named = raw.toLowerCase().replace(/\s+/g, " ");
    const used = definitions.filter(([label]) => named.includes(label)).map(([, line]) => line);
    return used.length ? `${raw}\n\n${used.join("\n")}` : raw;
  };
  return (
    <div className="markdown">
      {tokens.map((token, n) => {
        const from = start;
        start += token.raw.length;
        if (token.type === "space" || token.type === "def") return null;
        const mine = chunks.filter((c) => c.to > from && c.from < start).map((c) => ({ ...c, from: c.from - from, to: c.to - from }));
        // A fence still being written is left as it is: closing marks inside it would show as its text.
        const open = n === tail && openFence(token.raw);
        const raw = n === tail && !open ? settle(token.raw) : token.raw;
        return <Block key={n} text={token.type === "code" ? token.raw : withDefinitions(raw)} keep={`${keep}:${n}`} chip={chip} open={open} chunks={mine.length ? mine : NONE} />;
      })}
    </div>
  );
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ITEM = /^(\d{1,9})[.)] \S/;
const BULLET = /^[-*+] \S/;

/**
 * Agents often leave a draft's fence, or an item's bullets, at column 0 under a numbered item, which ends the
 * list there. They are indented into the item before drawing [D520]: a fence always, bullets when
 * another numbered item follows, there are two or more, or the item ends with ":". shortcut: an indent added
 * mid-stream shifts that moment's fading chunk by its width, until chunks are kept by the written text.
 */
function nestUnderItems(text: string): string {
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

/**
 * A reply's last block while it's still written: a mark it opened and hasn't closed yet (code, bold, italics, a
 * link's address) is closed, and a half-written image is held back, so neither ever shows raw [D520].
 */
function settle(raw: string) {
  const text = raw.replace(/(\*\*|`)\s*$/, "").replace(/!\[[^\]\n]*(\]\([^)\n]*)?$/, "").trimEnd();
  const odd = (mark: RegExp) => (text.match(mark)?.length ?? 0) % 2 === 1;
  const bold = odd(/`/g) ? `${text}\`` : odd(/\*\*/g) ? `${text}**` : text;
  // A lone `*` opening italics on the last line; one before a space is a bullet or a times sign.
  const line = bold.slice(bold.lastIndexOf("\n") + 1).replace(/\*\*/g, "");
  const closed = /(^|[\s(])\*(?=\S)[^*]*$/.test(line) && (line.match(/\*/g)?.length ?? 0) % 2 === 1 ? `${bold}*` : bold;
  return /\[[^\]]*\]\([^)]*$/.test(closed) ? `${closed})` : closed;
}

/** Whether a block ends inside a fence it opened: its code is still arriving. */
function openFence(raw: string): boolean {
  let mark = "";
  for (const line of raw.split("\n")) {
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) continue;
    if (!mark) mark = fence[1]!;
    else if (fence[1]![0] === mark[0] && fence[1]!.length >= mark.length && !fence[2]!.trim()) mark = "";
  }
  return mark !== "";
}

const keepChips = (url: string) => (url.startsWith("chip:") ? url : defaultUrlTransform(url));

/** Text that arrived from offset `from` to `to` at `at` (ms since the epoch). */
type Chunk = { from: number; to: number; at: number };
const NONE: Chunk[] = [];
// Past --animate-chunk-in's 0.7 s, so a chunk is never unwrapped mid-fade.
const FADE_MS = 1000;

/** The chunks still fading: each piece a text grows by. A reply that arrives whole draws solid, never grey first. */
function useChunks(text: string): Chunk[] {
  const seen = useRef<{ length: number; chunks: Chunk[] } | null>(null);
  const now = Date.now();
  if (!seen.current || text.length < seen.current.length) {
    seen.current = { length: text.length, chunks: [] };
  } else if (text.length > seen.current.length) {
    seen.current.chunks.push({ from: seen.current.length, to: text.length, at: now });
    seen.current.length = text.length;
  }
  seen.current.chunks = seen.current.chunks.filter((chunk) => now - chunk.at < FADE_MS);
  return seen.current.chunks;
}

/** Wraps each chunk's text in a fading span. shortcut: offsets are the source's, counted back from a text's end, so an escape or entity can move a chunk's edge by a character. */
const fadeChunks = (chunks: Chunk[]) => (tree: Node) => {
  const walk = (node: Node) => {
    node.children = node.children?.flatMap((child) => {
      walk(child);
      const value = child.value ?? "";
      const end = child.position?.end.offset;
      if (child.type !== "text" || end === undefined) return [child];
      const base = end - value.length;
      const out: Node[] = [];
      let done = 0;
      for (const chunk of chunks) {
        const from = Math.max(chunk.from - base, done);
        const to = Math.min(chunk.to - base, value.length);
        if (from >= to) continue;
        if (from > done) out.push({ type: "text", value: value.slice(done, from) });
        out.push({ type: "element", tagName: "span", properties: { dataAt: chunk.at }, children: [{ type: "text", value: value.slice(from, to) }] });
        done = to;
      }
      if (!out.length) return [child];
      if (done < value.length) out.push({ type: "text", value: value.slice(done) });
      return out;
    });
  };
  walk(tree);
};

/** GitHub's alert, a quote opening with `[!WARNING]` or its kin: the quote is marked as that callout and loses the marker [D477]. */
const callouts = () => (tree: Node) => {
  const walk = (node: Node) => {
    for (const child of node.children ?? []) walk(child);
    if (node.tagName !== "blockquote") return;
    const p = node.children?.find((c) => c.tagName === "p");
    const first = p?.children?.[0];
    const hit = first?.type === "text" ? /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/.exec(first.value ?? "") : null;
    if (!p || !first || !hit) return;
    node.properties = { ...node.properties, dataCallout: hit[1] };
    first.value = first.value!.slice(hit[0].length);
    if (!first.value && p.children![1]?.tagName === "br") p.children!.splice(0, 2);
  };
  walk(tree);
};

/** A chunk fading in; drawn again or reused mid-fade, it carries on from when its text arrived. */
function Fade({ at, children }: { at: number; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const now = document.timeline.currentTime;
    if (typeof now === "number") for (const fade of ref.current?.getAnimations() ?? []) fade.startTime = now - (Date.now() - at);
  }, [at]);
  return (
    <span ref={ref} className="animate-chunk-in">
      {children}
    </span>
  );
}

const Block = memo(function Block({ text, keep, chip, open, chunks }: { text: string; keep: string; chip?: (n: number) => ReactNode; open: boolean; chunks: Chunk[] }) {
  // Where a fence still being written ends: the block's end, as it never closed.
  const end = open ? text.trimEnd().length : -1;
  const components = useMemo(() => fences(keep, chip, end), [keep, chip, end]);
  return (
    <ReactMarkdown
      remarkPlugins={plugins}
      rehypePlugins={chunks.length ? [callouts, [fadeChunks, chunks]] : [callouts]}
      components={components}
      urlTransform={chip ? keepChips : defaultUrlTransform}
    >
      {text}
    </ReactMarkdown>
  );
});

const textOf = (node?: Node): string => node?.value ?? (node?.children ?? []).map(textOf).join("");

type Node = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown; dataAt?: number; dataRef?: string; dataCallout?: string };
  data?: { meta?: string };
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: Node[];
};

/**
 * Fenced code becomes a code block; inline code stays react-markdown's. A chip's link becomes its chip. A word or
 * inline code an answer's refs know becomes the composer's chip (refs.tsx); a web link opens in the browser [D251, D252].
 */
const fences = (keep: string, chip?: (n: number) => ReactNode, openEnd = -1): Components => ({
  span: ({ node, ...span }) => {
    const { dataAt: at, dataRef: word } = (node as Node | undefined)?.properties ?? {};
    if (word !== undefined) return <RefWord word={word} plain={span.children} />;
    return at === undefined ? <span {...span} /> : <Fade at={at}>{span.children}</Fade>;
  },
  // A new window's open goes to the browser (main.ts); a plain click's navigation is refused there.
  a: ({ node: _, href, ...link }) => {
    if (chip && href?.startsWith("chip:")) return chip(Number(href.slice(5)));
    const pr = href && pastedRef(href);
    if (pr) return <PrHoverCard refName={pr}><a href={href} target="_blank" rel="noreferrer" {...link} /></PrHoverCard>;
    if (!href || /^(https?:|mailto:|#)/i.test(href)) return <a href={href} target="_blank" rel="noreferrer" {...link} />;
    return <RefWord word={linkPath(href)} label={link.children} plain={<a href={href} {...link} />} />;
  },
  // Its words from the tree, as a chunk still fading splits them.
  code: ({ node, children, ...rest }) => <RefWord word={textOf(node as Node | undefined)} plain={<code {...rest}>{children}</code>} />,
  ...(chip && {
    // A chip typed between backticks still shows as itself, as the old app lifted it out of the code.
    // shortcut: one inside a fenced block shows its placeholder, until a user's code block draws chips.
    code: ({ node: _, children, ...rest }) =>
      typeof children === "string" ? (
        children.split(/\[@\]\(chip:(\d+)\)/).map((piece, at) => (at % 2 ? <Fragment key={at}>{chip(Number(piece))}</Fragment> : piece && <code key={at} {...rest}>{piece}</code>))
      ) : (
        <code {...rest}>{children}</code>
      ),
  }),
  pre: ({ node, children }) => {
    const code = (node as Node | undefined)?.children?.[0];
    if (code?.tagName !== "code") return <pre>{children}</pre>;
    const classes = Array.isArray(code.properties?.className) ? (code.properties.className as string[]) : [];
    const language = classes.find((name) => name.startsWith("language-"))?.slice("language-".length) ?? "";
    const text = (code.children ?? []).map((child) => child.value ?? "").join("");
    // Keyed by where the code starts, so two code blocks in one list keep their own fold.
    const at = `${keep}:${code.position?.start.offset ?? 0}`;
    // Still being written: no copy of half its text, and a card's JSON isn't shown raw while it arrives [D520].
    const live = openEnd >= 0 && (node?.position?.end.offset ?? 0) >= openEnd;
    // Something to post, as it will look: its markdown drawn in the draft, copied as written [D446].
    if (language === "preview") {
      const said = text.replace(/\n$/, "");
      return (
        <Draft keep={at} icon={<Eye className="size-icon-sm shrink-0" />} title={code.data?.meta || "Preview"} text={said} live={live}>
          <div className="px-4 pt-1 pb-3">
            <Markdown text={said} keep={at} />
          </div>
        </Draft>
      );
    }
    // A reply's card, drawn once its JSON is whole and fits; until then, or if it never does, a code block [D477].
    const card = live ? replyCardFrame(language) : replyCard(language, text, at);
    if (card) return card;
    // The words after a fence's language name what it is: a draft's destination, a diff's file [D477].
    const meta = code.data?.meta;
    const said = text.replace(/\n$/, "");
    const Icon = KIND_ICONS[language] ?? Code;
    const title = meta ? (
      <>
        <Icon className="size-icon-sm" />
        <span className="font-medium text-foreground">{meta}</span>
      </>
    ) : undefined;
    // Words to paste somewhere, a `text <where>` fence, are a writing card in the reply's own font
    // [D520]; a bare `text` fence is output, logs or an error, so a code block [D749].
    if (WRITING.test(language) && meta) return <WritingCard title={meta} text={said} keep={at} live={live} />;
    return <CodeBlock code={said} language={language} keep={at} title={title} live={live} />;
  },
  // A GitHub alert (`> [!WARNING]`) is a callout; any other quote stays a quote [D477].
  blockquote: ({ node, children }) => {
    const kind = (node as Node | undefined)?.properties?.dataCallout;
    if (!kind) return <blockquote>{children}</blockquote>;
    const warn = kind === "WARNING" || kind === "CAUTION";
    const Mark = warn ? Warning : Info;
    return (
      <div data-callout={kind.toLowerCase()} className={warn ? "callout callout-warn" : "callout"}>
        <div className="callout-head">
          <Mark className="size-icon-sm" />
          {warn ? "Watch out" : "Note"}
        </div>
        {children}
      </div>
    );
  },
});

const WRITING = /^(text|txt|plain|plaintext)$/i;

const KIND_ICONS: Record<string, typeof Code> = { sh: Terminal, bash: Terminal, zsh: Terminal, shell: Terminal, diff: Compare };
