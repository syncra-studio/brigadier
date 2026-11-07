import { useEffect, useState } from "react";

import { CopyButton } from "../components/copy-button";
import { ChevronDown, ChevronUp, Code } from "../icons";
import { highlight } from "./highlight";
import { useKept } from "./kept";
import "./code.css";

/** A block longer than this many lines starts folded, to `FOLDED_LINES`. */
const LONG_LINES = 14;
const FOLDED_LINES = 10;

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
const languageName = (language: string) => NAMES[language.toLowerCase()] ?? (language ? language[0]!.toUpperCase() + language.slice(1) : "Text");

/** A fenced code block: its language and copy over the code, coloured once it settles, folded when long. */
export function CodeBlock({ code, language, keep }: { code: string; language: string; keep: string }) {
  const [open, setOpen] = useKept(keep);
  const count = code.split("\n").length;
  const long = count > LONG_LINES;
  // Folded, only the lines on show are drawn and coloured, so a huge block costs no more than a short one.
  const shown = long && !open ? code.split("\n", FOLDED_LINES).join("\n") : code;
  const html = useHighlight(shown, language);
  return (
    <div className="relative my-3 overflow-clip rounded-thread border border-border bg-code-surface first:mt-0 last:mb-0">
      <div className="flex h-control-md items-center gap-1.5 bg-code-surface ps-3 pe-1.5 text-xs text-muted-foreground">
        <Code className="size-icon-sm" />
        <span className="font-medium">{languageName(language)}</span>
        {long && <span>· {count.toLocaleString()} lines</span>}
        <CopyButton text={code} tooltip="Copy" copiedTooltip={long ? `Copied ${count.toLocaleString()} lines` : "Copied"} size="icon-xs" className="ms-auto" />
      </div>
      <div className="relative">
        <pre className="overflow-x-auto px-3 pb-3 font-mono text-sm leading-relaxed">
          {html === null ? <code>{shown}</code> : <code dangerouslySetInnerHTML={{ __html: html }} />}
        </pre>
        {long && !open && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-11.5 bg-linear-to-t from-code-surface" />}
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex h-control-md w-full cursor-pointer items-center gap-1.5 border-t border-divider px-3 text-xs text-muted-foreground transition-colors hover:bg-fill-subtle hover:text-foreground focus-visible:focus-ring"
        >
          {open ? <ChevronUp className="size-icon-sm" /> : <ChevronDown className="size-icon-sm" />}
          {open ? "Show less" : `Show more · lines ${FOLDED_LINES + 1}–${count.toLocaleString()}`}
        </button>
      )}
    </div>
  );
}

/** The highlighter's escaped HTML for `code`, once it has stopped changing for a moment; null until then. */
function useHighlight(code: string, language: string): string | null {
  const [done, setDone] = useState<{ code: string; html: string | null } | null>(null);
  useEffect(() => {
    if (!language) return;
    let live = true;
    const timer = window.setTimeout(() => {
      highlight(code, language).then(
        (html) => live && setDone({ code, html }),
        () => live && setDone({ code, html: null }),
      );
    }, 120);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [code, language]);
  return done?.code === code ? done.html : null;
}
