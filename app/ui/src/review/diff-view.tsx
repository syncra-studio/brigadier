import { type ComponentType, lazy, type ReactNode, Suspense, useState } from "react";

import { cx } from "../components/cx";

/**
 * How a diff is drawn in the Review tab (old diffView). The engine loads on demand; until it has, the lines show
 * plain in the same type, so nothing jumps.
 */

/** A file's change: one patch, or (whole files loaded) both of its sides. */
export type DiffSource = { kind: "patch"; patch: string } | { kind: "sides"; path: string; before: string; after: string };

export type DiffLook = {
  /** Line numbers, and unchanged stretches folded with a count that opens in place. */
  numbered: boolean;
  split: boolean;
  wrap: boolean;
  /** The words a replaced line changed, marked. */
  words: boolean;
};

/** Something shown under a line: `side` "additions" is the new file's, "deletions" the old one's. */
export type DiffNote<T> = { side: "additions" | "deletions"; lineNumber: number; metadata: T };

/** A run of lines, as the engine reports a selection or a "+" press. */
export type LineRange = { start: number; end: number; side?: "additions" | "deletions"; endSide?: "additions" | "deletions" };

export type DiffViewProps<T> = {
  source: DiffSource;
  look: DiffLook;
  annotations?: DiffNote<T>[];
  renderAnnotation?: (annotation: DiffNote<T>) => ReactNode;
  /** A "+" by the hovered line's number, and what it does. */
  onGutterClick?: (range: LineRange) => void;
  /** Lines picked by dragging over their numbers. */
  onSelect?: (range: LineRange) => void;
  /** The lines shown picked. */
  selected?: LineRange | null;
};

type Engine = ComponentType<DiffViewProps<unknown>>;

// Once its code is in (warmed at idle), a diff draws at once: a lazy view would hold its plain lines a moment more.
let loaded: Engine | null = null;
let loading: Promise<typeof import("./engine")> | null = null;
const load = () =>
  (loading ??= import("./engine").then(
    (module) => ((loaded = module.default as Engine), module),
    (error: unknown) => {
      // A failed load is tried again the next time.
      loading = null;
      throw error;
    },
  ));
const Lazy = lazy(() => load().then((module) => ({ default: module.default as Engine })));

/**
 * At idle after startup, what opening a diff needs: the engine's code, its highlighter and the common grammars.
 * Nothing waits for it; a diff opened before it ends loads what it needs as before.
 */
export function warmReview(): void {
  const start = () => void load().then((module) => module.warmDiffs()).catch((error: unknown) => console.error("warming the diff engine failed", error));
  setTimeout(() => requestIdleCallback(start, { timeout: 2000 }), 2000);
}

export function DiffView<T>(props: DiffViewProps<T>) {
  // Chosen once per mount: the code arriving meanwhile must not remount what shows.
  const [Shown] = useState<Engine>(() => loaded ?? Lazy);
  return (
    <Suspense fallback={<PlainLines source={props.source} wrap={props.look.wrap} />}>
      <Shown {...(props as DiffViewProps<unknown>)} />
    </Suspense>
  );
}

/** The change's lines as text, while the engine loads. */
export function PlainLines({ source, wrap }: { source: DiffSource; wrap: boolean }) {
  const lines =
    source.kind === "sides"
      ? source.after.replace(/\n$/, "").split("\n")
      : source.patch
          .replace(/\n$/, "")
          .split("\n")
          .filter((line) => /^[ +-]/.test(line) && !/^(---|\+\+\+) /.test(line));
  return (
    <pre data-slot="diff-plain" className={cx("px-3 font-mono text-diff text-muted-foreground", wrap ? "whitespace-pre-wrap" : "whitespace-pre")}>
      {lines.join("\n")}
    </pre>
  );
}
