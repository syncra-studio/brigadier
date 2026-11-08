import type { SVGProps } from "react";

/*
 * Brigadier's mark at rest, the old app's striped disc (brand-glyph.tsx): a solid core with bars
 * through it and fifteen thin strokes around it, on a 256-unit grid, in the current colour.
 */

/** Each column's thin stroke height, 14.4 apart from x 27.2; the core's bars stand in columns 2 to 12. */
const STRIPES = [38.4, 108.8, 145.6, 171.2, 185.6, 198.4, 204.8, 211.2, 204.8, 198.4, 185.6, 171.2, 145.6, 108.8, 38.4];
const CORE_BARS = [0, 0, 57.6, 97.6, 124.8, 144, 153.6, 156.8, 153.6, 144, 124.8, 97.6, 57.6, 0, 0];

/** A vertical bar with round ends centred on (`cx`, 128). */
const bar = (cx: number, width: number, height: number) => (
  <rect key={`${cx}-${width}`} x={cx - width / 2} y={128 - height / 2} width={width} height={height} rx={width / 2} />
);

export function BrigadierMark(props: SVGProps<SVGSVGElement>) {
  const x = (column: number) => 27.2 + column * 14.4;
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden {...props}>
      {STRIPES.map((height, column) => bar(x(column), 4.4, height))}
      <circle cx={128} cy={128} r={59} />
      {CORE_BARS.map((height, column) => height > 0 && bar(x(column), 9.6, height))}
    </svg>
  );
}
