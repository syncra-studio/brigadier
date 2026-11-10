/**
 * A file's colours: the same shiki and pierre-dark as the review diff [D1059, D1042], through @pierre/diffs's shared
 * highlighter, loaded on the first file so the app starts without it.
 */

/** A coloured piece of a line. */
export type Token = { content: string; colour: string | undefined; italic: boolean };

/** Text longer than this shows without colours, which would take too long to work out (the old cap). */
export const HIGHLIGHT_CHARS = 300_000;

/** The review diff's highlighter type (review/engine.tsx): one type may load per window. */
const HIGHLIGHTER = "shiki-wasm";

/** shiki's FontStyle.Italic bit. */
const ITALIC = 1;

/** The lines of a file as coloured tokens, or null for a kind of file without a grammar. */
export async function highlight(text: string, path: string): Promise<Token[][] | null> {
  const { getFiletypeFromFileName, getSharedHighlighter } = await import("@pierre/diffs");
  const lang = getFiletypeFromFileName(path);
  if (lang === "text") return null;
  const shiki = await getSharedHighlighter({ themes: ["pierre-dark"], langs: [lang], preferredHighlighter: HIGHLIGHTER });
  return shiki
    .codeToTokens(text, { lang, theme: "pierre-dark" })
    .tokens.map((line) => line.map((token) => ({ content: token.content, colour: token.color, italic: ((token.fontStyle ?? 0) & ITALIC) !== 0 })));
}
