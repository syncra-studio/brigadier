// The desktop's own icon files (app/ui/src/icons) drawn on the phone as they are [D98, D99, D102]: Metro gives those
// files this JSX runtime (metro.config.js), which swaps their svg tags for react-native-svg's and their Tailwind
// classes for the theme's values.
import { Fragment, jsx as reactJsx } from "react/jsx-runtime";
import { Circle, Path, Rect, Svg, Text } from "react-native-svg";
import { color, colorOf, opacity, space, spacing } from "./theme";

const TAGS: Record<string, unknown> = { svg: Svg, path: Path, circle: Circle, rect: Rect, text: Text };
const camel = (s: string) => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** The classes an icon carries, as the props they mean; the rest (shrink-0, a CSS hook) draws nothing here. */
function fromClasses(className: string) {
  const out: Record<string, number | string> = {};
  for (const name of className.split(/\s+/).filter(Boolean)) {
    const [, kind, rest] = /^(size|text|opacity)-(.+)$/.exec(name) ?? [];
    if (kind === "size") out.width = out.height = /^[\d.]+$/.test(rest) ? space(Number(rest)) : spacing[camel(rest)];
    else if (kind === "text") out.color = colorOf(rest);
    else if (kind === "opacity") out.opacity = /^\d+$/.test(rest) ? Number(rest) / 100 : opacity[camel(rest)];
  }
  return out;
}

function props(tag: string, given: Record<string, unknown>) {
  const { className, "aria-hidden": _hidden, pathLength, ...rest } = given;
  // A class beats an attribute (width="1em", or a size the phone passes), as CSS does; a 1em left is the icon size.
  const out: Record<string, unknown> = { ...rest, ...(typeof className === "string" ? fromClasses(className) : {}) };
  if (out.width === "1em") out.width = spacing.iconMd;
  if (out.height === "1em") out.height = spacing.iconMd;
  // The desktop's currentColor is the text's around it; react-native-svg's is black, so the text's own default.
  if (tag === "svg" && out.color === undefined) out.color = color.foreground;
  // react-native-svg has no pathLength: a circle's dashes are scaled to its real length instead.
  if (pathLength !== undefined && tag === "circle" && typeof out.strokeDasharray === "string") {
    const scale = (2 * Math.PI * Number(out.r)) / Number(pathLength);
    out.strokeDasharray = out.strokeDasharray.split(/[\s,]+/).map((n) => Number(n) * scale);
  }
  return out;
}

export function jsx(type: unknown, given: Record<string, unknown>, key?: string) {
  if (typeof type !== "string") return reactJsx(type as never, given, key);
  const tag = TAGS[type];
  if (!tag) throw new Error(`svg-jsx: the desktop's icons use <${type}>, which the phone doesn't draw yet`);
  return reactJsx(tag as never, props(type, given), key);
}
export const jsxs = jsx;
export const jsxDEV = jsx;
export { Fragment };
