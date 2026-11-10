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

/** The theme paints its own near-black; the diff sits on the tab's background instead. */
const ON_TAB = "pre { --diffs-bg: var(--color-background) !important; background-color: var(--color-background) !important; }";

export default function PierreDiff<T>({
  source,
  look,
  annotations,
  renderAnnotation,
  onGutterClick,
  onSelect,
  selected,
}: DiffViewProps<T>) {
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
      unsafeCSS: ON_TAB,
      ...(onGutterClick && { enableGutterUtility: true, onGutterUtilityClick: (range: SelectedLineRange) => onGutterClick(range) }),
      ...(onSelect && { enableLineSelection: true, onLineSelectionEnd: (range: SelectedLineRange | null) => range && onSelect(range) }),
    }),
    [look.numbered, look.split, look.wrap, look.words, onGutterClick, onSelect],
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
