import { getSharedHighlighter } from "@pierre/diffs";
import { type DiffLineAnnotation, type FileDiffOptions, MultiFileDiff, PatchDiff, type SelectedLineRange } from "@pierre/diffs/react";
import { type ReactNode, useMemo } from "react";

import type { DiffViewProps } from "./diff-view";

/**
 * The diff engine itself (old PierreDiff), loaded on demand through `DiffView` so it and its highlighter never weigh on
 * the first paint. Lines in pierre-dark's syntax colours (D1042), changed lines tinted with a bar at their start, the
 * words a replaced line changed marked. Its type and spacing come from the `diff-look` utility.
 */

/** Shiki's WebAssembly highlighter, several times faster than its JavaScript one (needs 'wasm-unsafe-eval'). */
const HIGHLIGHTER = "shiki-wasm";

const COMMON_LANGUAGES = ["typescript", "tsx", "javascript", "json", "rust", "python", "css", "html", "bash", "toml", "yaml"];

/** A few lines with the constructs most files use: coloured at idle, they leave a first diff little to compile. */
const WARM_PIECES = `import { type FC, useEffect } from "react";
// A line comment
/** A doc comment. */
export interface Props<T extends object = {}> { readonly id: string; items?: T[]; onPick: (item: T) => void }
export class Store<T> extends Base { private static count = 0; get size(): number { return this.count; } }
export const view: FC<Props> = ({ id }) => <div className="a">{\`\${id}\`}</div>;
async function load(): Promise<void> { for (const x of [1, 2]) await fetch(\`/\${x}\`); }`.split(/\n(?=[^\s}])/);

const yieldToPage = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Loads the highlighter, its theme and the common grammars ahead of the first diff, a piece at a time. */
export async function warmDiffs(): Promise<void> {
  const shiki = await getSharedHighlighter({ themes: ["pierre-dark"], langs: COMMON_LANGUAGES, preferredHighlighter: HIGHLIGHTER });
  for (const lang of ["typescript", "tsx"]) {
    for (const piece of WARM_PIECES) {
      shiki.codeToTokens(piece, { lang, theme: "pierre-dark" });
      await yieldToPage();
    }
  }
}

/**
 * The theme paints its own near-black; the diff sits on the tab's background instead. A picked range's fill stops at
 * its lines: the box, notes and hunk bars under them don't take it.
 */
const ON_TAB = `pre { --diffs-bg: var(--color-background) !important; background-color: var(--color-background) !important; }
:is([data-line-annotation], [data-gutter-buffer=annotation])[data-selected-line] { --diffs-computed-selected-line-bg: var(--diffs-computed-diff-line-bg) !important; }`;

/**
 * GitHub's two number columns: a removed line's number in the first, an added one's in the second, an unchanged
 * line's old number (copied onto its cell by `oldNumbers`) beside its new one. Margins, not pseudo-elements, move a
 * changed line's: their ::before is the engine's change bar.
 */
const COLUMNS = `[data-column-number] > [data-line-number-content], [data-column-number][data-alt]::before { display: inline-block; min-width: 5ch; text-align: end; }
[data-column-number][data-alt]::before { content: attr(data-alt); margin-inline-end: 1ch; }
[data-column-number][data-line-type="change-addition"] > [data-line-number-content] { margin-inline-start: 6ch; }
[data-column-number][data-line-type="change-deletion"] > [data-line-number-content] { margin-inline-end: 6ch; }`;

/** Each unchanged line's old number onto its number cell, which shows the new one, for COLUMNS to show. */
function oldNumbers(node: HTMLElement) {
  const root = node.shadowRoot ?? node;
  const cells = new Map([...root.querySelectorAll<HTMLElement>("[data-column-number]")].map((cell) => [cell.dataset.lineIndex, cell]));
  for (const line of root.querySelectorAll<HTMLElement>("[data-alt-line]")) cells.get(line.dataset.lineIndex)?.setAttribute("data-alt", line.dataset.altLine ?? "");
}

export default function PierreDiff<T>({
  source,
  look,
  annotations,
  renderAnnotation,
  onGutterClick,
  onSelect,
  selected,
}: DiffViewProps<T>) {
  const sides = source.kind === "patch" ? source.sides : undefined;
  const options = useMemo<FileDiffOptions<T, undefined>>(
    () => ({
      theme: "pierre-dark",
      themeType: "dark",
      preferredHighlighter: HIGHLIGHTER,
      disableFileHeader: true,
      disableLineNumbers: !look.numbered,
      diffStyle: look.split ? "split" : "unified",
      overflow: look.wrap ? "wrap" : "scroll",
      lineDiffType: look.words ? "word" : "none",
      hunkSeparators: look.numbered ? "line-info" : "simple",
      expandUnchanged: false,
      unsafeCSS: look.columns ? ON_TAB + COLUMNS : ON_TAB,
      ...(look.columns && { onPostRender: oldNumbers }),
      ...(onGutterClick && { enableGutterUtility: true, onGutterUtilityClick: (range: SelectedLineRange) => onGutterClick(range) }),
      ...(onSelect && { enableLineSelection: true, onLineSelectionEnd: (range: SelectedLineRange | null) => range && onSelect(range) }),
      ...(sides && {
        loadDiffFiles: async (diff) => {
          const { before, after } = await sides();
          return { oldFile: { name: diff.prevName ?? diff.name, contents: before }, newFile: { name: diff.name, contents: after } };
        },
      }),
    }),
    [look.numbered, look.split, look.wrap, look.words, look.columns, onGutterClick, onSelect, sides],
  );
  const shared = {
    options,
    className: "diff-look",
    selectedLines: selected ?? null,
    ...(annotations && { lineAnnotations: annotations as unknown as DiffLineAnnotation<T>[] }),
    ...(renderAnnotation && { renderAnnotation: renderAnnotation as unknown as (annotation: DiffLineAnnotation<T>) => ReactNode }),
  };
  return source.kind === "sides" ? (
    <MultiFileDiff<T> {...shared} oldFile={{ name: source.path, contents: source.before }} newFile={{ name: source.path, contents: source.after }} />
  ) : (
    <PatchDiff<T> {...shared} patch={source.patch} />
  );
}
