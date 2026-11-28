// The phone's look values, read from the desktop's theme (app/ui/src/theme.css) when Metro bundles [D99, D102]:
// src/theme-values.js is replaced by its `@theme static` tokens, grouped by kind, with variables resolved, colours and
// calc() lowered to sRGB and px by lightningcss (the desktop's own CSS engine), and rem, em and unitless line heights
// turned into the numbers React Native takes. Nothing is copied, so nothing can drift.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { transform, Features } = require("lightningcss");
const upstream = require("@expo/metro-config/babel-transformer");

const THEME = path.resolve(__dirname, "../app/ui/src/theme.css");
const STUB = path.resolve(__dirname, "src/theme-values.js");
const NIGHT = path.resolve(__dirname, "../app/ui/src/sessions/overnight.css");
const CODE = path.resolve(__dirname, "../app/ui/src/thread/code.css");
const REM = 16;

/** `--name: value` pairs of the `@theme static` block, comments dropped. */
function declarations(css) {
  const start = css.indexOf("@theme static {");
  const block = css.slice(start, css.indexOf("\n}\n", start)).replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map();
  for (const [, name, value] of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(name, value.replace(/\s+/g, " ").trim());
  return out;
}

/** Every var() replaced by its token's value, to the bottom; one outside the block keeps its fallback or stays. */
function resolver(raw) {
  const done = new Map();
  const resolve = (name, seen = []) => {
    if (done.has(name)) return done.get(name);
    if (seen.includes(name)) throw new Error(`theme.css: --${name} refers to itself`);
    const value = raw.get(name).replace(/var\(--([a-z0-9-]+)(?:\s*,\s*([^()]*))?\)/g, (whole, ref, fallback) =>
      raw.has(ref) ? resolve(ref, [...seen, name]) : (fallback ?? whole));
    done.set(name, value);
    return value;
  };
  return resolve;
}

const GROUPS = ["font-weight", "color", "spacing", "radius", "text", "font", "shadow", "opacity", "leading", "tracking", "container", "blur", "duration", "ease", "animate", "scale", "z-index"];
const groupOf = (name) => GROUPS.find((g) => name === g || name.startsWith(`${g}-`));
const camel = (s) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

/** The CSS property lightningcss lowers a token's value under; null, it isn't a colour or a length. */
function property(name, group, value) {
  if (/gradient\(/.test(value)) return "background-image";
  if (name.includes("--")) return null;
  return { color: "color", shadow: "box-shadow", radius: "border-radius", spacing: "width", container: "width", blur: "width", text: "width" }[group] ?? null;
}

/** Each value lowered by lightningcss in one sheet: colours to sRGB (its fallback, the first declaration), calc() folded. */
function lower(entries) {
  const sheet = entries.map(([, prop, value], i) => (prop ? `.t${i}{${prop}:${value}}` : "")).join("\n");
  const { code } = transform({ filename: "theme.css", code: Buffer.from(sheet), minify: true, include: Features.Colors });
  const out = entries.map(([, , value]) => value);
  for (const [, selectors, body] of code.toString().matchAll(/((?:\.t\d+,?)+)\{([^}]*)\}/g)) {
    const first = body.slice(body.indexOf(":") + 1).split(";")[0];
    for (const [, i] of selectors.matchAll(/\.t(\d+)/g)) out[Number(i)] = first;
  }
  return out;
}

const inPx = (value) => value.replace(/(-?\d*\.?\d+)rem\b/g, (_, n) => `${Number(n) * REM}px`);
const pxOf = (value) => {
  // A calc() of lengths alone, which lightningcss leaves when the units differ (calc(3.25rem + 2px)), is summed.
  const sum = /^calc\(([\d.px +-]+)\)$/.exec(inPx(value));
  if (sum) return sum[1].split(/\s+(?=[+-]\s)/).reduce((total, part) => total + Number.parseFloat(part.replace(/\s/g, "")), 0);
  const m = /^(-?[\d.]+)(rem|px)?$/.exec(value);
  return m ? Number(m[1]) * (m[2] === "rem" ? REM : 1) : null;
};

/**
 * Overnight's composer card (overnight.css `.night-sky`): its fill and ring, and its ::before glow and ::after stars as
 * layers, each an opacity and a background image, the tokens resolved and lowered as the theme's are, rem in px.
 */
function night(css, resolve, raw) {
  const sheet = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (pseudo) => {
    const selector = `.night-sky [data-slot="composer-card"]${pseudo} {`;
    const at = sheet.indexOf(selector);
    if (at < 0) throw new Error(`overnight.css: no ${selector}`);
    const body = sheet.slice(at + selector.length, sheet.indexOf("}", at)).replace(/var\(--([a-z0-9-]+)\)/g, (whole, name) => (raw.has(name) ? resolve(name) : whole));
    const { code } = transform({ filename: "overnight.css", code: Buffer.from(`.n{${body}}`), minify: true, include: Features.Colors });
    // The first of each property: lightningcss puts the sRGB fallback first.
    const out = {};
    // React Native reads a gradient's position only in px or %: lightningcss's bare 0 (`at 100% 0`) becomes 0%.
    const native = (value) => inPx(value).replace(/\bat ([^,]+)/g, (place) => place.replace(/(^|\s)0(?=\s|$)/g, "$10%"));
    for (const [, prop, value] of code.toString().matchAll(/([a-z-]+):([^;}]+)/g)) out[camel(prop)] ??= native(value);
    return out;
  };
  const card = rule("");
  const layer = ({ opacity, backgroundImage }) => ({ opacity: Number(opacity), backgroundImage });
  return { card: { backgroundColor: card.backgroundColor, boxShadow: card.boxShadow }, glow: layer(rule("::before")), stars: layer(rule("::after")) };
}

/**
 * A code card's colours (thread/code.css): each highlight.js selector (`hljs-title.class_`) with the colour and fill its
 * @apply gives, the theme's tokens lowered as above. A diff card's own and the full-width wash are the desktop's alone.
 */
function syntax(css, byName) {
  const out = {};
  const sheet = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@reference[^;]*;/g, "");
  for (const [, selectors, body] of sheet.matchAll(/([^{}]+)\{\s*@apply ([^;]+);\s*\}/g)) {
    const style = {};
    for (const [, prop, name] of body.matchAll(/(?:^|\s)(text|bg)-([a-z0-9-]+)/g)) {
      if (!byName.has(`color-${name}`)) throw new Error(`code.css: no --color-${name}`);
      style[prop === "text" ? "color" : "backgroundColor"] = byName.get(`color-${name}`);
    }
    for (const selector of selectors.split(",").map((each) => each.trim())) {
      if (/^(\.hljs-[\w-]+)(\.[\w-]+)*$/.test(selector)) out[selector.slice(1)] = { ...out[selector.slice(1)], ...style };
    }
  }
  return out;
}

function values(css, nightCss, codeCss) {
  const raw = declarations(css);
  const resolve = resolver(raw);
  const names = [...raw.keys()].filter((name) => groupOf(name));
  const lowered = lower(names.map((name) => [name, property(name, groupOf(name), resolve(name)), resolve(name)]));
  const byName = new Map(names.map((name, i) => [name, lowered[i]]));
  const theme = Object.fromEntries(GROUPS.map((g) => [camel(g), {}]));
  for (const name of names) {
    const group = groupOf(name);
    const key = name === group ? "base" : camel(name.slice(group.length + 1));
    const value = byName.get(name);
    if (group === "text") continue;
    if (group === "opacity") theme.opacity[key] = /%$/.test(value) ? Number.parseFloat(value) / 100 : Number(value);
    else if (group === "font-weight") theme.fontWeight[key] = value;
    else if (group === "font") theme.font[key] = value.split(",").map((f) => f.trim().replace(/^"|"$/g, ""));
    else if (group === "leading" || group === "tracking" || group === "scale") theme[camel(group)][key] = Number.parseFloat(value);
    else if (group === "duration") theme.duration[key] = Number.parseFloat(value) * (/ms$/.test(value) ? 1 : 1000);
    else theme[camel(group)][key] = pxOf(value) ?? inPx(value);
  }
  // A text size with its line height. An em size is of the chat's text, the one prose the desktop sizes in em
  // (markdown.css: headings, inline code). A unitless line height is times its size; none, it inherits.
  for (const name of names.filter((n) => groupOf(n) === "text" && !n.includes("--") && !n.startsWith("text-underline"))) {
    const key = camel(name.slice(5));
    const size = byName.get(name);
    const base = /em$/.test(size) && !/rem$/.test(size) ? "text-chat" : null;
    const fontSize = Math.round((base ? Number.parseFloat(size) * pxOf(byName.get(base)) : pxOf(size)) * 100) / 100;
    const line = byName.get(`${name}--line-height`);
    const lineHeight = line === undefined ? undefined : /(rem|px)$/.test(line) ? pxOf(line) : Number.parseFloat(line) * fontSize;
    theme.text[key] = lineHeight === undefined ? { fontSize } : { fontSize, lineHeight: Math.round(lineHeight * 100) / 100 };
  }
  if (nightCss) theme.night = night(nightCss, resolve, raw);
  if (codeCss) theme.syntax = syntax(codeCss, byName);
  return theme;
}

module.exports = {
  values,
  transform(args) {
    if (path.resolve(args.filename) !== STUB) return upstream.transform(args);
    return upstream.transform({ ...args, src: `module.exports = ${JSON.stringify(values(...[THEME, NIGHT, CODE].map((file) => fs.readFileSync(file, "utf8"))))};` });
  },
  // shortcut: Metro takes this key once per server, so a dev server keeps the old values after a theme.css edit until
  // it restarts (`npx expo start -c`); every Xcode bundle starts a new one. Upgrade if anyone styles live against it.
  getCacheKey(...args) {
    const theme = crypto.createHash("sha1").update(fs.readFileSync(THEME)).update(fs.readFileSync(NIGHT)).update(fs.readFileSync(CODE)).update(fs.readFileSync(__filename)).digest("hex");
    return `${upstream.getCacheKey ? upstream.getCacheKey(...args) : ""}${theme}`;
  },
};
