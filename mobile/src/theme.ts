// The phone's look values: the desktop's own theme (app/ui/src/theme.css), read when Metro bundles (../theme-css.js),
// under the desktop's token names [D98, D99, D102]. The desktop is dark only, so the phone is too.
import values from "./theme-values";

/** A token theme.css doesn't have (a typo, or one the desktop dropped) throws where it's read. */
function strict<T extends object>(kind: string, of: T, check?: (value: unknown) => boolean): T {
  return new Proxy(of, {
    get(target, key) {
      const value = (target as Record<PropertyKey, unknown>)[key];
      if (typeof key === "string" && (value === undefined || (check && !check(value)))) throw new Error(`theme.css has no usable --${kind}-${key}: ${String(value)}`);
      return value;
    },
  });
}
const px = (value: unknown) => typeof value === "number";

export const color = strict("color", values.color);
export const spacing = strict("spacing", values.spacing, px);
export const radius = strict("radius", values.radius, px);
export const text = strict("text", values.text);
export const fontWeight = strict("font-weight", values.fontWeight);
export const shadow = strict("shadow", values.shadow);
export const opacity = strict("opacity", values.opacity);
export const leading = strict("leading", values.leading);
export const tracking = strict("tracking", values.tracking);
export const duration = strict("duration", values.duration);
/** Overnight's composer card, from the desktop's sessions/overnight.css. */
export const night = values.night;
/** A code card's colours, from the desktop's thread/code.css. */
export const syntax = values.syntax;

/** A colour by its desktop name, as a class or a CSS variable writes it: "muted-foreground" is color.mutedForeground. */
export const colorOf = (name: string) => color[name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())];

/** Tailwind's numbered spacing: the desktop's `p-2` is `space(2)`. */
export const space = (n: number) => n * values.spacing.base;

// The phone's own: iOS opens neither ui-monospace nor SF Mono to apps, so the mono stack's first family it ships;
// and the least a finger needs (Apple's guidelines), made up with a hitSlop round a smaller control.
export const mono = values.font.mono.find((family) => family === "Menlo" || family === "Courier") ?? "Menlo";
export const touch = 44;
