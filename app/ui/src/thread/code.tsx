import { type ReactNode, useEffect, useState } from "react";

import { FOLDED_LINES, foldWords, isProse, languageName, LONG_LINES, linesWords } from "../../../shared/code";
import { CopyButton } from "../components/copy-button";
import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { ArrowCurvedLeft, ChevronDown, ChevronUp, Code } from "../icons";
import { useFindSearching } from "./find-text";
import { highlight } from "../../../shared/highlight";
import { useKept } from "./kept";
import "./code.css";

/** A reply's code block, a card [D92], or a file change's diff card: the same drawing, each in its own frame. */
const LOOKS = {
  code: {
    card: "my-4.5 rounded-thread bg-code-card first:mt-0 last:mb-0",
    head: "h-12 gap-2 ps-5 pe-1.5 text-sm text-chat-foreground",
    pre: "px-5 pb-3 text-code",
    fade: "from-code-card",
    border: "border border-code-card-edge",
    button: "icon-code",
  },
  diff: {
    card: "mt-1 rounded-shell",
    head: "min-h-8 gap-2 bg-fill-subtle ps-3 pe-1 text-sm text-action-hover",
    pre: "px-3 text-diff",
    fade: "from-background",
    border: "border border-border",
    button: "icon-xs",
  },
} as const;

/**
 * A fenced code block: its language and copy over the code, coloured once it settles, folded when long.
 * `title` stands in for the language's icon and name; `look` "diff" draws it as a file change's diff card.
 * `live`: still being written, so it offers no copy of half its text.
 */
export function CodeBlock({
  code,
  language,
  keep,
  title,
  look = "code",
  live = false,
}: {
  code: string;
  language: string;
  keep: string;
  title?: ReactNode;
  look?: keyof typeof LOOKS;
  live?: boolean;
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
  // A plain-text block, like a draft to copy, wraps instead of scrolling sideways [D248]; code wraps when asked [D525].
  const prose = isProse(language);
  const [wrap, setWrap] = useKept(`${keep}:wrap`);
  const canWrap = !prose && look === "code";
  return (
    <div data-look={look} className={cx("relative overflow-clip", frame.border, frame.card)}>
      <div className={cx("flex items-center", frame.head)}>
        {title ?? (
          <>
            <Code className="size-icon-sm" />
            <span className="font-medium">{languageName(language)}</span>
          </>
        )}
        {long && <span className="font-normal text-muted-foreground">{linesWords(count)}</span>}
        {canWrap && (
          <TooltipIconButton
            tooltip={wrap ? "Don't wrap lines" : "Wrap lines"}
            pressed={wrap}
            size={frame.button}
            className="ms-auto aria-pressed:bg-fill-subtle aria-pressed:text-foreground"
            onClick={() => setWrap(!wrap)}
          >
            <ArrowCurvedLeft />
          </TooltipIconButton>
        )}
        {!live && <CopyButton text={code} tooltip="Copy" copiedTooltip={long ? `Copied ${count.toLocaleString()} lines` : "Copied"} size={frame.button} className={canWrap ? undefined : "ms-auto"} />}
      </div>
      <div className="relative">
        <pre data-find-clip={cut || undefined} className={cx("overflow-x-auto font-mono", (prose || wrap) && "break-words whitespace-pre-wrap", frame.pre, cut && "max-h-code-folded overflow-y-hidden")}>
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
          {foldWords(open, count)}
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
