// A reply's code block's words and fold, for both apps: drawing stays in each.

/** A block longer than this many lines starts folded, to `FOLDED_LINES`. */
export const LONG_LINES = 14;
export const FOLDED_LINES = 10;

const NAMES: Record<string, string> = {
  bash: "Bash",
  sh: "Shell",
  zsh: "Shell",
  shell: "Shell",
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  javascript: "JavaScript",
  jsx: "JSX",
  py: "Python",
  python: "Python",
  rs: "Rust",
  rust: "Rust",
  json: "JSON",
  diff: "Diff",
  css: "CSS",
  html: "HTML",
  md: "Markdown",
  markdown: "Markdown",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  sql: "SQL",
};
export const languageName = (language: string) => NAMES[language.toLowerCase()] ?? (language ? language[0]!.toUpperCase() + language.slice(1) : "Text");

/** A plain-text block, like a draft to copy, wraps instead of scrolling sideways [D248]. */
export const isProse = (language: string) => /^(|text|txt|plain|plaintext)$/i.test(language);

export const linesWords = (count: number) => `· ${count.toLocaleString()} lines`;
export const foldWords = (open: boolean, count: number) => (open ? "Show less" : `Show more · lines ${FOLDED_LINES + 1}–${count.toLocaleString()}`);
