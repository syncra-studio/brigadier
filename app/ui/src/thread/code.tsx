import { type ReactNode, useEffect, useState } from "react";

import { CopyButton } from "../components/copy-button";
import { cx } from "../components/cx";
import { ChevronDown, ChevronUp, Code } from "../icons";
import { useFindSearching } from "./find-text";
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

/** A reply's code block, or a file change's diff card: the same drawing, each in its own frame. */
const LOOKS = {
  code: {
    card: "my-3 rounded-thread bg-code-surface first:mt-0 last:mb-0",
    head: "h-control-md gap-1.5 bg-code-surface pe-1.5 text-xs text-muted-foreground",
    pre: "pb-3 text-sm leading-relaxed",
    fade: "from-code-surface",
  },
  diff: {
    card: "mt-1 rounded-shell",
    head: "min-h-8 gap-2 bg-fill-subtle pe-1 text-sm text-action-hover",
    pre: "text-diff",
    fade: "from-background",
  },
} as const;

/**
 * A fenced code block: its language and copy over the code, coloured once it settles, folded when long.
 * `title` stands in for the language's icon and name; `look` "diff" draws it as a file change's diff card.
 */
export function CodeBlock({
  code,
  language,
  keep,
  title,
  look = "code",
}: {
  code: string;
  language: string;
  keep: string;
  title?: ReactNode;
  look?: keyof typeof LOOKS;
}) {
  const frame = LOOKS[look];
  const [open, setOpen] = useKept(keep);
  const count = code.split("\n").length;
  const long = count > LONG_LINES;
  // Folded, only the lines on show are drawn and coloured, so a huge block costs no more than a short one; while
  // find searches, all of them, cut to the fold, so they are found (find.tsx opens it to go to one).
  const searched = useFindSearching();
  const cut = long && !open && searched;
  const shown = long && !open && !searched ? code.split("\n", FOLDED_LINES).join("\n") : code;
  const html = useHighlight(shown, language);
  return (
    <div data-look={look} className={cx("relative overflow-clip border border-border", frame.card)}>
      <div className={cx("flex items-center ps-3", frame.head)}>
        {title ?? (
          <>
            <Code className="size-icon-sm" />
            <span className="font-medium">{languageName(language)}</span>
          </>
        )}
        {long && <span>· {count.toLocaleString()} lines</span>}
        <CopyButton text={code} tooltip="Copy" copiedTooltip={long ? `Copied ${count.toLocaleString()} lines` : "Copied"} size="icon-xs" className="ms-auto" />
      </div>
      <div className="relative">
        <pre data-find-clip={cut || undefined} className={cx("overflow-x-auto px-3 font-mono", frame.pre, cut && "max-h-code-folded overflow-y-hidden")}>
          {html === null ? <code>{shown}</code> : <code dangerouslySetInnerHTML={{ __html: html }} />}
        </pre>
        {long && !open && <div aria-hidden className={cx("pointer-events-none absolute inset-x-0 bottom-0 h-11.5 bg-linear-to-t", frame.fade)} />}
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          data-kept={keep}
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
