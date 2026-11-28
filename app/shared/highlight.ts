// A code block's colours for both apps: highlight.js's classes, each app drawing them in the theme's syntax colours.
import type { HLJSApi, LanguageFn } from "highlight.js";

// Loaded on the first code block, so the app starts without it.
let ready: Promise<HLJSApi> | undefined;

const LANGUAGES: Record<string, () => Promise<{ default: LanguageFn }>> = {
  typescript: () => import("highlight.js/lib/languages/typescript"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  rust: () => import("highlight.js/lib/languages/rust"),
  python: () => import("highlight.js/lib/languages/python"),
  bash: () => import("highlight.js/lib/languages/bash"),
  json: () => import("highlight.js/lib/languages/json"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  ini: () => import("highlight.js/lib/languages/ini"),
  css: () => import("highlight.js/lib/languages/css"),
  xml: () => import("highlight.js/lib/languages/xml"),
  go: () => import("highlight.js/lib/languages/go"),
  sql: () => import("highlight.js/lib/languages/sql"),
  diff: () => import("highlight.js/lib/languages/diff"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
};
const ALIASES: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", rs: "rust", py: "python", sh: "bash", shell: "bash", zsh: "bash", yml: "yaml", toml: "ini", html: "xml", md: "markdown", patch: "diff" };

/** `code` as escaped HTML with highlight.js classes, or null for a language it doesn't know. */
export async function highlight(code: string, language: string): Promise<string | null> {
  const name = ALIASES[language.toLowerCase()] ?? language.toLowerCase();
  const load = LANGUAGES[name];
  if (!load) return null;
  const hljs = await (ready ??= import("highlight.js/lib/core").then((module) => module.default));
  if (!hljs.getLanguage(name)) hljs.registerLanguage(name, (await load()).default);
  return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
}
