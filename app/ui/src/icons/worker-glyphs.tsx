import { cx } from "../components/cx";

/**
 * Workers' avatars: rank and corps insignia on a 16-unit grid, each drawn in one glyph colour, a
 * light body (`base`) under the full-tone earned part (`mark`). A worker keeps the same one wherever it appears.
 */
interface Glyph {
  base: string;
  mark: string;
  color: string;
}

const COLORS = [
  "text-glyph-1",
  "text-glyph-2",
  "text-glyph-3",
  "text-glyph-4",
  "text-glyph-5",
  "text-glyph-6",
  "text-glyph-7",
  "text-glyph-8",
] as const;

const SHAPES: readonly Omit<Glyph, "color">[] = [
  // Private.
  { base: "M1.2 12.54L7.2 7.54L8.8 9.46L2.8 14.46ZM8.8 7.54L14.8 12.54L13.2 14.46L7.2 9.46ZM8 8.5L7.2 7.54L8 6.87L8.8 7.54Z", mark: "M1.2 6.54L7.2 1.54L8.8 3.46L2.8 8.46ZM8.8 1.54L14.8 6.54L13.2 8.46L7.2 3.46ZM8 2.5L7.2 1.54L8 0.87L8.8 1.54Z" },
  // Corporal.
  { base: "M1.2 14.54L7.2 9.54L8.8 11.46L2.8 16.46ZM8.8 9.54L14.8 14.54L13.2 16.46L7.2 11.46ZM8 10.5L7.2 9.54L8 8.87L8.8 9.54Z", mark: "M1.2 5.54L7.2 0.54L8.8 2.46L2.8 7.46ZM8.8 0.54L14.8 5.54L13.2 7.46L7.2 2.46ZM8 1.5L7.2 0.54L8 -0.13L8.8 0.54ZM1.2 10.04L7.2 5.04L8.8 6.96L2.8 11.96ZM8.8 5.04L14.8 10.04L13.2 11.96L7.2 6.96ZM8 6L7.2 5.04L8 4.37L8.8 5.04Z" },
  // Sergeant.
  { base: "M2.8 0.54L8.8 5.54L7.2 7.46L1.2 2.46ZM7.2 5.54L13.2 0.54L14.8 2.46L8.8 7.46ZM8.8 7.46L8 8.13L7.2 7.46L8 6.5ZM2.8 4.29L8.8 9.29L7.2 11.21L1.2 6.21ZM7.2 9.29L13.2 4.29L14.8 6.21L8.8 11.21ZM8.8 11.21L8 11.88L7.2 11.21L8 10.25Z", mark: "M2.8 8.04L8.8 13.04L7.2 14.96L1.2 9.96ZM7.2 13.04L13.2 8.04L14.8 9.96L8.8 14.96ZM8.8 14.96L8 15.63L7.2 14.96L8 14Z" },
  // Rocker.
  { base: "M2 10.5Q8 15.5 14 10.5V13.3Q8 18 2 13.3Z", mark: "M2.8 0.54L8.8 5.54L7.2 7.46L1.2 2.46ZM7.2 5.54L13.2 0.54L14.8 2.46L8.8 7.46ZM8.8 7.46L8 8.13L7.2 7.46L8 6.5ZM2.8 4.54L8.8 9.54L7.2 11.46L1.2 6.46ZM7.2 9.54L13.2 4.54L14.8 6.46L8.8 11.46ZM8.8 11.46L8 12.13L7.2 11.46L8 10.5Z" },
  // Lieutenant.
  { base: "M2 1.5L4.5 1.5L4.5 14.5L2 14.5ZM11.5 1.5L14 1.5L14 14.5L11.5 14.5Z", mark: "M6.75 1.5L9.25 1.5L9.25 14.5L6.75 14.5Z" },
  // Captain.
  { base: "M6 3.5L10 3.5L10 5.5L6 5.5ZM6 10.5L10 10.5L10 12.5L6 12.5Z", mark: "M3 1.5L6 1.5L6 14.5L3 14.5ZM10 1.5L13 1.5L13 14.5L10 14.5Z" },
  // Service.
  { base: "M1.5 6.5L14.5 6.5L14.5 9.5L1.5 9.5ZM1.5 11L14.5 11L14.5 14L1.5 14Z", mark: "M1.5 2L14.5 2L14.5 5L1.5 5Z" },
  // Hash.
  { base: "M5.94 12.94L12.94 5.94L15.06 8.06L8.06 15.06Z", mark: "M0.94 7.94L7.94 0.94L10.06 3.06L3.06 10.06Z" },
  // Star.
  { base: "M8 1.2L9.76 6.17L15.04 6.31L10.85 9.53L12.35 14.59L8 11.6L3.65 14.59L5.15 9.53L0.96 6.31L6.24 6.17Z", mark: "M8 8.6L8 1.2L9.76 6.17ZM8 8.6L15.04 6.31L10.85 9.53ZM8 8.6L12.35 14.59L8 11.6ZM8 8.6L3.65 14.59L5.15 9.53ZM8 8.6L0.96 6.31L6.24 6.17Z" },
  // Two stars.
  { base: "M11 6.6L12.06 9.54L15.18 9.64L12.71 11.56L13.59 14.56L11 12.8L8.41 14.56L9.29 11.56L6.82 9.64L9.94 9.54Z", mark: "M5 1.1L6.06 4.04L9.18 4.14L6.71 6.06L7.59 9.06L5 7.3L2.41 9.06L3.29 6.06L0.82 4.14L3.94 4.04Z" },
  // Star and bar.
  { base: "M2 12L14 12L14 14.5L2 14.5Z", mark: "M8 0.8L9.23 4.3L12.95 4.39L10 6.65L11.06 10.21L8 8.1L4.94 10.21L6 6.65L3.05 4.39L6.77 4.3Z" },
  // Crown.
  { base: "M1.5 4L5 7.5L8 2L11 7.5L14.5 4L13.5 11H2.5Z", mark: "M2.5 12L13.5 12L13.5 14.5L2.5 14.5Z" },
  // Tower.
  { base: "M2 2H4.5V4H6.75V2H9.25V4H11.5V2H14V14.5H2Z", mark: "M6 14.5V10.5a2 2 0 0 1 4 0V14.5Z" },
  // Cog.
  { base: "M15.16 6.58L15.16 9.42L13.1 9.01L12.32 10.89L14.07 12.06L12.06 14.07L10.89 12.32L9.01 13.1L9.42 15.16L6.58 15.16L6.99 13.1L5.11 12.32L3.94 14.07L1.93 12.06L3.68 10.89L2.9 9.01L0.84 9.42L0.84 6.58L2.9 6.99L3.68 5.11L1.93 3.94L3.94 1.93L5.11 3.68L6.99 2.9L6.58 0.84L9.42 0.84L9.01 2.9L10.89 3.68L12.06 1.93L14.07 3.94L12.32 5.11L13.1 6.99ZM8 5.4a2.6 2.6 0 1 0 0 5.2a2.6 2.6 0 1 0 0-5.2Z", mark: "M8 5.4a2.6 2.6 0 1 1 0 5.2a2.6 2.6 0 1 1 0-5.2Z" },
  // Spear.
  { base: "M6.75 8L9.25 8L9.25 15L6.75 15Z", mark: "M8 1L12 6.5H9.25V8H6.75V6.5H4Z" },
  // Sabres.
  { base: "M2.88 1.12L14.88 13.12L13.12 14.88L1.12 2.88Z", mark: "M1.12 13.12L13.12 1.12L14.88 2.88L2.88 14.88Z" },
  // Advance.
  { base: "M8.88 1.12L14.88 7.12L13.12 8.88L7.12 2.88ZM14.88 8.88L8.88 14.88L7.12 13.12L13.12 7.12ZM14 8L14.88 7.12L15.77 8L14.88 8.88Z", mark: "M3.38 1.12L9.38 7.12L7.62 8.88L1.62 2.88ZM9.38 8.88L3.38 14.88L1.62 13.12L7.62 7.12ZM8.5 8L9.38 7.12L10.27 8L9.38 8.88Z" },
  // Trident.
  { base: "M2 1H4.5V6.5H11.5V1H14V9H2Z", mark: "M6.75 1H9.25V15H6.75Z" },
  // Master.
  { base: "M2 12L14 12L14 14.5L2 14.5Z", mark: "M1.2 5.54L7.2 0.54L8.8 2.46L2.8 7.46ZM8.8 0.54L14.8 5.54L13.2 7.46L7.2 2.46ZM8 1.5L7.2 0.54L8 -0.13L8.8 0.54ZM1.2 10.04L7.2 5.04L8.8 6.96L2.8 11.96ZM8.8 5.04L14.8 10.04L13.2 11.96L7.2 6.96ZM8 6L7.2 5.04L8 4.37L8.8 5.04Z" },
  // Medal.
  { base: "M3 1.5H6.5L8 5.5L9.5 1.5H13L10 7.5H6Z", mark: "M8 6.25a4.25 4.25 0 1 1 0 8.5a4.25 4.25 0 1 1 0-8.5Z" },
  // Starred chevron.
  { base: "M1.12 12.44L7.12 7.44L8.88 9.56L2.88 14.56ZM8.88 7.44L14.88 12.44L13.12 14.56L7.12 9.56ZM8 8.5L7.12 7.44L8 6.71L8.88 7.44Z", mark: "M8 1.3L9 4.12L11.99 4.2L9.62 6.03L10.47 8.9L8 7.2L5.53 8.9L6.38 6.03L4.01 4.2L7 4.12Z" },
  // Grid.
  { base: "M4 1.5L6.5 1.5L6.5 14.5L4 14.5ZM9.5 1.5L12 1.5L12 14.5L9.5 14.5Z", mark: "M1.5 4L14.5 4L14.5 6.5L1.5 6.5ZM1.5 9.5L14.5 9.5L14.5 12L1.5 12Z" },
  // Anchor.
  { base: "M1.5 8.5H4.25A3.75 3.75 0 0 0 11.75 8.5H14.5A6.5 6.5 0 0 1 1.5 8.5Z", mark: "M6.75 1.5L9.25 1.5L9.25 13.5L6.75 13.5ZM4 3.5L12 3.5L12 5.75L4 5.75Z" },
  // Arrows.
  { base: "M11 1.5L14.25 5.5H12.25V14.5H9.75V5.5H7.75Z", mark: "M5 1.5L8.25 5.5H6.25V14.5H3.75V5.5H1.75Z" },
];

const GLYPHS: readonly Glyph[] = SHAPES.map((shape, index) => ({
  ...shape,
  color: COLORS[index % COLORS.length] ?? COLORS[0],
}));

/** The glyph for an id: `h = (h * 31 + c) % 2147483647` over its characters, then `h % N`. */
function glyphFor(id: string): Glyph {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 2147483647;
  return GLYPHS[hash % GLYPHS.length] ?? (GLYPHS[0] as Glyph);
}

/**
 * A worker's own two-tone avatar, the same wherever it appears: 1em square in its own colour unless sized or coloured
 * by the caller.
 */
export function WorkerGlyph({ id, className }: { id: string; className?: string }) {
  const glyph = glyphFor(id);
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      fill="currentColor"
      className={cx("shrink-0", glyph.color, className ?? "size-icon-md")}
    >
      <path d={glyph.base} className="opacity-45" />
      <path d={glyph.mark} />
    </svg>
  );
}

/** The Workers and Subagents tabs' icon: one worker glyph [D83]. */
export const TeamGlyph = ({ className }: { className?: string }) => <WorkerGlyph id="workers" className={className} />;
