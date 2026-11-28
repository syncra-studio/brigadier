import { useEffect, useState } from "react";

import { highlight } from "../../../shared/highlight";
import { cx } from "./cx";

/**
 * A small script's lines, numbered and coloured, editable in place: the old app's editor [D391]. A see-through
 * textarea lies over the coloured text, so typing, selection and undo stay the browser's own.
 */
export function CodeEditor({ id, value, onChange, language, label, placeholder, className }: { id?: string; value: string; onChange: (value: string) => void; language: string; label: string; placeholder?: string; className?: string }) {
  const [coloured, setColoured] = useState<{ text: string; html: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    // Each edit colours afresh; until it lands, the text shows plain.
    highlight(value, language).then((html) => live && setColoured({ text: value, html }), () => {});
    return () => {
      live = false;
    };
  }, [value, language]);
  const html = coloured?.text === value ? coloured.html : null;
  return (
    <div data-slot="code-editor" className={cx("overflow-auto py-2 font-mono text-xs focus-within:focus-ring", className)}>
      <div className="flex min-h-full w-max min-w-full">
        <div aria-hidden className="shrink-0 ps-4 pe-4 text-end leading-5 text-muted-foreground select-none">
          {value.split("\n").map((_, index) => (
            <div key={index} className="h-5">
              {index + 1}
            </div>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          {/* The added newline: a last one alone draws no line, and the caret needs that line. */}
          {html === null ? <pre aria-hidden className="pe-4 font-mono leading-5">{`${value}\n`}</pre> : <pre aria-hidden className="pe-4 font-mono leading-5" dangerouslySetInnerHTML={{ __html: `${html}\n` }} />}
          <textarea
            id={id}
            aria-label={label}
            value={value}
            placeholder={placeholder}
            wrap="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => onChange(event.target.value)}
            className="absolute inset-0 resize-none overflow-hidden bg-transparent pe-4 font-mono text-xs leading-5 whitespace-pre text-transparent caret-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>
    </div>
  );
}
