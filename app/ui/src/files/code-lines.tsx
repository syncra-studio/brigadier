import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";

import { cx } from "../components/cx";
import { FindLineBox, MAX_MATCHES } from "./find-line-box";
import { HIGHLIGHT_CHARS, highlight, type Token } from "./highlight";

type Match = { line: number; start: number; end: number };
type Range = { start: number; end: number; current: boolean };

/** A line's text in coloured pieces, with the parts in `ranges` marked (the current one more). */
function marked(pieces: readonly Pick<Token, "content" | "colour" | "italic">[], ranges: readonly Range[]): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const [index, piece] of pieces.entries()) {
    const start = at;
    const end = at + piece.content.length;
    at = end;
    let cut = start;
    const parts: ReactNode[] = [];
    for (const range of ranges) {
      if (range.end <= cut || range.start >= end) continue;
      const from = Math.max(range.start, cut);
      const to = Math.min(range.end, end);
      if (from > cut) parts.push(piece.content.slice(cut - start, from - start));
      parts.push(
        <mark key={`${index}:${from}`} data-current={range.current || undefined} className="rounded-xs bg-find-match text-inherit data-current:bg-find-current">
          {piece.content.slice(from - start, to - start)}
        </mark>,
      );
      cut = to;
    }
    if (cut < end) parts.push(piece.content.slice(cut - start));
    out.push(
      // Pieces of a line never reorder.
      <span key={index} data-colour={piece.colour} className={cx(piece.colour && "token-colour", piece.italic && "italic")}>
        {parts}
      </span>,
    );
  }
  return out;
}

/**
 * A file's lines, only those in view drawn: line numbers, colours below the size cap, ⌘F to find and ⌃G to go to a
 * line while `active` [D1002]. `line` (asked again with a new `reveal`) marks a line and brings it into view.
 */
export function CodeLines({
  text,
  path,
  line = null,
  reveal = 0,
  active,
  defaultFind,
  defaultGoing = false,
}: {
  text: string;
  path: string;
  line?: number | null;
  reveal?: number;
  active: boolean;
  /** Opens with the find box holding this (the gallery's frozen states). */
  defaultFind?: string;
  defaultGoing?: boolean;
}) {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  const [tokens, setTokens] = useState<{ text: string; tokens: Token[][] | null } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useRef<VirtualizerHandle>(null);
  // The line gone to with ⌃G, until a link asks for another.
  const asked = `${line}:${reveal}`;
  const [goneTo, setGoneTo] = useState<{ asked: string; line: number } | null>(null);
  const target = goneTo?.asked === asked ? goneTo.line : line;
  const [finding, setFinding] = useState(defaultFind !== undefined);
  const [query, setQuery] = useState(defaultFind ?? "");
  const [current, setCurrent] = useState(0);
  const [going, setGoing] = useState(defaultGoing);
  const findInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (text.length > HIGHLIGHT_CHARS) return;
    let live = true;
    highlight(text.replace(/\n$/, ""), path)
      .then((result) => live && setTokens({ text, tokens: result }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [text, path]);
  const lineTokens = tokens?.text === text ? tokens.tokens : null;

  const matches = useMemo<Match[]>(() => {
    const want = query.toLowerCase();
    if (!finding || !want) return [];
    const found: Match[] = [];
    for (const [index, content] of lines.entries()) {
      const lower = content.toLowerCase();
      for (let from = lower.indexOf(want); from >= 0 && found.length < MAX_MATCHES; from = lower.indexOf(want, from + want.length)) {
        found.push({ line: index + 1, start: from, end: from + want.length });
      }
      if (found.length >= MAX_MATCHES) break;
    }
    return found;
  }, [lines, query, finding]);
  const byLine = useMemo(() => {
    const map = new Map<number, Range[]>();
    for (const [index, match] of matches.entries()) {
      const list = map.get(match.line) ?? [];
      list.push({ start: match.start, end: match.end, current: index === current });
      map.set(match.line, list);
    }
    return map;
  }, [matches, current]);

  // A link (again) at a line marks it and brings it into view.
  useLayoutEffect(() => {
    if (line !== null && line > 0) virtualizer.current?.scrollToIndex(line - 1, { align: "center" });
  }, [line, reveal]);
  const match = matches[current];
  useLayoutEffect(() => {
    if (match) virtualizer.current?.scrollToIndex(match.line - 1, { align: "center" });
  }, [match]);

  // ⌘F finds and ⌃G goes to a line (Ctrl+F and Ctrl+G off macOS), while the tab is in front.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.shiftKey) return;
      const mac = /Mac/.test(navigator.platform);
      const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      const control = event.ctrlKey && !event.metaKey;
      if (command && event.code === "KeyF") {
        event.preventDefault();
        setGoing(false);
        setFinding(true);
        requestAnimationFrame(() => findInput.current?.select());
      } else if (control && event.code === "KeyG") {
        event.preventDefault();
        setFinding(false);
        setGoing(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  const step = (by: 1 | -1) => {
    if (matches.length) setCurrent((at) => (at + by + matches.length) % matches.length);
  };
  const goTo = (value: string) => {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return;
    const clamped = Math.min(lines.length, Math.max(1, number));
    setGoneTo({ asked, line: clamped });
    virtualizer.current?.scrollToIndex(clamped - 1, { align: "center" });
    setGoing(false);
    scrollRef.current?.focus();
  };

  const digits = String(lines.length).length;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {(finding || going) && (
        <FindLineBox
          finding={finding}
          query={query}
          count={matches.length}
          current={current}
          lines={lines.length}
          inputRef={findInput}
          onQueryChange={(value) => {
            setQuery(value);
            setCurrent(0);
          }}
          onStep={step}
          onGoTo={goTo}
          onFindEscape={() => {
            setFinding(false);
            scrollRef.current?.focus();
          }}
          onGoEscape={() => {
            setGoing(false);
            scrollRef.current?.focus();
          }}
          onClose={() => {
            setFinding(false);
            setGoing(false);
          }}
        />
      )}
      <div ref={scrollRef} data-selectable tabIndex={-1} className="min-h-0 flex-1 overflow-auto py-2 font-mono text-xs outline-none">
        <Virtualizer ref={virtualizer} scrollRef={scrollRef} data={lines} itemSize={20} bufferSize={400}>
          {(content: string, index: number) => {
            const number = index + 1;
            return (
              <div
                key={number}
                data-line={number}
                data-target={number === target || undefined}
                className="flex h-5 w-max min-w-full items-center leading-5 whitespace-pre data-target:bg-warning-wash"
              >
                <span data-digits={digits} className="line-gutter shrink-0 ps-4 pe-4 text-end text-muted-foreground select-none">
                  {number}
                </span>
                <span className="pe-4">{marked(lineTokens?.[index] ?? [{ content, colour: undefined, italic: false }], byLine.get(number) ?? [])}</span>
              </div>
            );
          }}
        </Virtualizer>
      </div>
    </div>
  );
}
