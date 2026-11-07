import { useEffect, useState } from "react";

import { highlight } from "./highlight";
import { useKept } from "./kept";
import "./code.css";

/** Lines a block shows before it folds. */
const FOLDED_LINES = 12;

/** A fenced code block: its language, the code coloured once it settles, folded when long. */
export function CodeBlock({ code, language, keep }: { code: string; language: string; keep: string }) {
  const [open, setOpen] = useKept(keep);
  const long = code.split("\n", FOLDED_LINES + 1).length > FOLDED_LINES;
  // Folded, only the lines on show are drawn and coloured, so a huge block costs no more than a short one.
  const shown = long && !open ? code.split("\n", FOLDED_LINES).join("\n") : code;
  const html = useHighlight(shown, language);
  return (
    <div className="my-3 flex flex-col rounded-control bg-code-surface first:mt-0 last:mb-0">
      <div className="flex items-center justify-between px-3 pt-2 text-xs text-muted-foreground">
        <span>{language || "text"}</span>
        {long && (
          <button type="button" className="hover:text-foreground" onClick={() => setOpen(!open)}>
            {open ? "Collapse" : "Expand"}
          </button>
        )}
      </div>
      <pre className="overflow-x-auto px-3 pt-1 pb-2 font-mono text-code">
        {html === null ? <code>{shown}</code> : <code dangerouslySetInnerHTML={{ __html: html }} />}
      </pre>
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
