import { Fragment, memo, type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { marked } from "marked";

import { Eye } from "../icons";
import { CodeBlock } from "./code";
import { RefWord, remarkRefs } from "./refs";

// Every line break kept, as written: the user's text and the agents' answers alike [D140].
const plugins = [remarkGfm, remarkBreaks, remarkRefs];

/**
 * A reply's markdown, one top-level block at a time, so while a reply streams only its last block parses
 * and draws again. marked only finds where blocks end (whole-reply parsing is what made rendering slow);
 * react-markdown draws each block. `chip` draws a `[@](chip:n)` link as the message's n-th chip, where the user
 * put it [D2107]. The chunks a streaming reply grows by fade in [D53].
 */
export function Markdown({ text, keep, chip, streaming }: { text: string; keep: string; chip?: (n: number) => ReactNode; streaming?: boolean }) {
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
        const raw = n === tail ? settle(token.raw) : token.raw;
        return <Block key={n} text={token.type === "code" ? token.raw : withDefinitions(raw)} keep={`${keep}:${n}`} chip={chip} chunks={mine.length ? mine : NONE} />;
      })}
    </div>
  );
}

/** A reply's last block while it's still written: a mark it opened and hasn't closed yet (code, bold, a link's address) is closed, so it never shows raw. */
function settle(raw: string) {
  const text = raw.replace(/(\*\*|`)\s*$/, "").trimEnd();
  const odd = (mark: RegExp) => (text.match(mark)?.length ?? 0) % 2 === 1;
  const closed = odd(/`/g) ? `${text}\`` : odd(/\*\*/g) ? `${text}**` : text;
  return /\[[^\]]*\]\([^)]*$/.test(closed) ? `${closed})` : closed;
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

const Block = memo(function Block({ text, keep, chip, chunks }: { text: string; keep: string; chip?: (n: number) => ReactNode; chunks: Chunk[] }) {
  const components = useMemo(() => fences(keep, chip), [keep, chip]);
  return (
    <ReactMarkdown
      remarkPlugins={plugins}
      rehypePlugins={chunks.length ? [[fadeChunks, chunks]] : undefined}
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
  properties?: { className?: unknown; dataAt?: number; dataRef?: string };
  data?: { meta?: string };
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: Node[];
};

/**
 * Fenced code becomes a code block; inline code stays react-markdown's. A chip's link becomes its chip. A word or
 * inline code an answer's refs know becomes the composer's chip (refs.tsx); a web link opens in the browser [D251, D252].
 */
const fences = (keep: string, chip?: (n: number) => ReactNode): Components => ({
  span: ({ node, ...span }) => {
    const { dataAt: at, dataRef: word } = (node as Node | undefined)?.properties ?? {};
    if (word !== undefined) return <RefWord word={word} plain={span.children} />;
    return at === undefined ? <span {...span} /> : <Fade at={at}>{span.children}</Fade>;
  },
  // A new window's open goes to the browser (main.ts); a plain click's navigation is refused there.
  a: ({ node: _, href, ...link }) => {
    if (chip && href?.startsWith("chip:")) return chip(Number(href.slice(5)));
    if (!href || /^(https?:|mailto:|#)/i.test(href)) return <a href={href} target="_blank" rel="noreferrer" {...link} />;
    return <RefWord word={href} plain={<a href={href} {...link} />} />;
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
    // Something to post, as it will look: its markdown drawn in the block, copied as written [D446].
    if (language === "preview")
      return (
        <CodeBlock
          code={text.replace(/\n$/, "")}
          language=""
          keep={at}
          title={
            <>
              <Eye className="size-icon-sm" />
              <span className="font-medium">{code.data?.meta || "Preview"}</span>
            </>
          }
          body={
            <div className="px-3 pt-1 pb-3">
              <Markdown text={text} keep={at} />
            </div>
          }
        />
      );
    return <CodeBlock code={text.replace(/\n$/, "")} language={language} keep={at} />;
  },
});
