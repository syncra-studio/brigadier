import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { marked } from "marked";

import { CodeBlock } from "./code";

const plugins = [remarkGfm];

/**
 * A reply's markdown, one top-level block at a time, so while a reply streams only its last block parses
 * and draws again. marked only finds where blocks end (whole-reply parsing is what made rendering slow);
 * react-markdown draws each block.
 */
export function Markdown({ text, keep }: { text: string; keep: string }) {
  const tokens = marked.lexer(text);
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
      {tokens.map((token, at) =>
        token.type === "space" || token.type === "def" ? null : (
          <Block key={at} text={token.type === "code" ? token.raw : withDefinitions(token.raw)} keep={`${keep}:${at}`} />
        ),
      )}
    </div>
  );
}

const Block = memo(function Block({ text, keep }: { text: string; keep: string }) {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={useMemo(() => fences(keep), [keep])}>
      {text}
    </ReactMarkdown>
  );
});

type Node = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  position?: { start: { offset?: number } };
  children?: Node[];
};

/** Fenced code becomes a code block; inline code stays react-markdown's. */
const fences = (keep: string): Components => ({
  pre: ({ node, children }) => {
    const code = (node as Node | undefined)?.children?.[0];
    if (code?.tagName !== "code") return <pre>{children}</pre>;
    const classes = Array.isArray(code.properties?.className) ? (code.properties.className as string[]) : [];
    const language = classes.find((name) => name.startsWith("language-"))?.slice("language-".length) ?? "";
    const text = (code.children ?? []).map((child) => child.value ?? "").join("");
    // Keyed by where the code starts, so two code blocks in one list keep their own fold.
    return <CodeBlock code={text.replace(/\n$/, "")} language={language} keep={`${keep}:${code.position?.start.offset ?? 0}`} />;
  },
});
