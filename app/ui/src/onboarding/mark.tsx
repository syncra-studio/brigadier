import { type SVGProps, useEffect, useRef, useState } from "react";

/*
 * Brigadier's mark, the old app's striped disc (brand-glyph.tsx): a solid core with bars through it and
 * fifteen thin strokes around it, on a 256-unit grid, in the current colour. With `spinOnHover` it spins
 * under the pointer: the columns drift rightward through the disc like a turning globe, each taking the
 * height of the column ahead, then coast to rest.
 */

const COLUMN_GAP = 14.4;
const FIRST_COLUMN_X = 27.2;
/** Each column's thin stroke height; the core's bars stand in columns 2 to 12. */
const STRIPES = [38.4, 108.8, 145.6, 171.2, 185.6, 198.4, 204.8, 211.2, 204.8, 198.4, 185.6, 171.2, 145.6, 108.8, 38.4];
const CORE_BARS = [0, 0, 57.6, 97.6, 124.8, 144, 153.6, 156.8, 153.6, 144, 124.8, 97.6, 57.6, 0, 0];
/** Columns drawn at any moment: one more than at rest, entering from the left while spinning. */
const COLUMNS = [-1, ...STRIPES.keys()];

/** Grid units per second (a column every 0.4 s), reached this many seconds in. */
const SPIN_SPEED = 36;
const SPIN_RAMP_S = 0.3;
/** How hard a released spin brakes, in units per second², and the crawl it never drops below. */
const SPIN_BRAKE = 120;
const SPIN_CRAWL = 6;

/** How far the columns have drifted past their rest; stays 0 under Reduce Motion. */
function useSpinOffset(spinning: boolean): number {
  const [offset, setOffset] = useState(0);
  const spinningRef = useRef(spinning);
  const frame = useRef<number | null>(null);
  useEffect(() => {
    spinningRef.current = spinning;
    if (!spinning || frame.current !== null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let at = 0;
    let speed = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(now - last, 50) / 1000;
      last = now;
      if (spinningRef.current) speed = Math.min(SPIN_SPEED, speed + (SPIN_SPEED / SPIN_RAMP_S) * dt);
      else speed = Math.max(SPIN_CRAWL, Math.min(speed, Math.sqrt(2 * SPIN_BRAKE * (COLUMN_GAP - at))));
      at += speed * dt;
      if (!spinningRef.current && at >= COLUMN_GAP) {
        frame.current = null;
        setOffset(0);
        return;
      }
      at %= COLUMN_GAP;
      setOffset(at);
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [spinning]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  return offset;
}

/** A vertical bar with round ends centred on (`cx`, 128); one shorter than it is wide narrows to a dot. */
const bar = (key: string, cx: number, width: number, height: number) => {
  const w = Math.min(width, height);
  return w > 0 && <rect key={key} x={cx - w / 2} y={128 - height / 2} width={w} height={height} rx={w / 2} />;
};

export function BrigadierMark({ spinOnHover = false, ...props }: SVGProps<SVGSVGElement> & { spinOnHover?: boolean }) {
  const [hovered, setHovered] = useState(false);
  const offset = useSpinOffset(spinOnHover && hovered);
  const t = offset / COLUMN_GAP;
  const x = (column: number) => FIRST_COLUMN_X + column * COLUMN_GAP + offset;
  const height = (heights: number[], column: number) => (heights[column] ?? 0) * (1 - t) + (heights[column + 1] ?? 0) * t;
  return (
    <svg
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden
      onPointerEnter={spinOnHover ? () => setHovered(true) : undefined}
      onPointerLeave={spinOnHover ? () => setHovered(false) : undefined}
      {...props}
    >
      {COLUMNS.map((column) => bar(`s${column}`, x(column), 4.4, height(STRIPES, column)))}
      <circle cx={128} cy={128} r={59} />
      {COLUMNS.map((column) => bar(`c${column}`, x(column), 9.6, height(CORE_BARS, column)))}
    </svg>
  );
}
