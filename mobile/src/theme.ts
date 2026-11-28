// The desktop's dark theme (app/ui/src/theme.css), the values the phone uses.
export const color = {
  background: "#181818",
  surfaceUnder: "#141414",
  muted: "#393939",
  foreground: "#dfdfdf",
  mutedForeground: "rgba(223,223,223,0.65)",
  primary: "#ffffff",
  primaryFg: "#0d0d0d",
  border: "rgba(255,255,255,0.084)",
  // The thread's: rows at 60% and their objects at 40%, the user's bubble, code and shell boxes, and the status colours.
  row: "rgba(223,223,223,0.6)",
  rowObject: "rgba(223,223,223,0.4)",
  faint: "rgba(255,255,255,0.5)",
  bubble: "#2f2f2e",
  chat: "#ffffff",
  fill: "rgba(255,255,255,0.078)",
  codeSurface: "#1f1f1f",
  link: "#83c3ff",
  destructive: "#ff6764",
  warning: "#e25507",
  success: "#54ce88",
  // The composer's (theme.css): its card, words, glyphs and the kinds' colours.
  composer: "#343434", // --color-composer
  composerGlow: "inset 0 0 1px 0 rgba(255,255,255,0.2)", // --shadow-composer (--shadow-hairline)
  placeholder: "rgba(223,223,223,0.3)", // --color-placeholder: muted-foreground at 46%
  queueGlyph: "rgba(223,223,223,0.455)", // --color-queue-glyph: muted-foreground at 70%
  input: "rgba(255,255,255,0.156)", // --color-input, the pills' divider
  fillHover: "rgba(255,255,255,0.12)", // --color-fill-hover
  popover: "#2d2d2d", // --color-popover, the menus'
  invalid: "rgba(255,103,100,0.5)", // --color-invalid: destructive at 50%
  picked: "rgba(131,195,255,0.2)", // --color-picked: link at 20%
  pickedRow: "rgba(131,195,255,0.15)", // --color-picked-row: link at 15%
  glyph5: "#f0b135", // --color-glyph-5, oklch(0.8 0.15 80): Fast's bolt, a favourite's star
  magenta: "#d080e2", // --color-ansi-magenta, oklch(0.72 0.16 320): a skill
  cyan: "#24c1c9", // --color-ansi-cyan, oklch(0.74 0.12 200): an MCP server or prompt
  violet: "#b197fc", // --color-tile-violet: Overnight's moon
  ring: "#0285ff", // --color-ring
  // The phone's own: the unread dot, a connected Mac's dot, a diff's added and removed lines, a picked option,
  // the image viewer's backdrop and the night sky behind Overnight's composer.
  unread: "#339cff",
  online: "#3fb950",
  added: "rgba(84,206,136,0.15)",
  removed: "rgba(255,103,100,0.15)",
  optionOn: "rgba(255,255,255,0.16)",
  viewer: "#000",
  nightSky: "radial-gradient(ellipse at top right, rgba(177,151,252,0.34), transparent 360px), radial-gradient(ellipse at bottom left, rgba(2,133,255,0.34), transparent 320px)",
};

// The composer's sizes (theme.css --spacing-*, --radius-*).
export const size = {
  controlXs: 24, // --spacing-control-xs
  controlSm: 28, // --spacing-control-sm: a pill, Send
  controlMd: 32, // --spacing-control-md: a rail row
  controlLg: 40, // --spacing-control-lg: a tile's icon box
  iconXs: 12, // --spacing-icon-xs
  iconSm: 14, // --spacing-icon-sm
  iconMd: 16, // --spacing-icon-md
  composer: 44, // --spacing-composer: the field's least height
  railInset: 13, // --spacing-rail-inset
  railTuck: 4, // --spacing-rail-tuck
  thumb: 54, // --spacing-attachment-thumb
  card: 224, // --spacing-attachment-card
  radiusComposer: 22, // --radius-composer
  radiusOverlay: 20, // --radius-overlay
  radiusMenu: 16, // --radius-menu
  radiusSurface: 12, // --radius-surface
  radiusIconButton: 10, // --radius-icon-button
  radiusControl: 8, // --radius-control
  disabled: 0.5, // --opacity-disabled
  touch: 44, // the least a finger needs: a hitSlop round a smaller control makes it up
};

export const mono = "Menlo";

export const text = {
  xs: { fontSize: 12, lineHeight: 16 },
  label: { fontSize: 13, lineHeight: 18 },
  sm: { fontSize: 14, lineHeight: 20 },
  base: { fontSize: 15, lineHeight: 24 },
  lg: { fontSize: 17, lineHeight: 26 },
  pageTitle: { fontSize: 28, lineHeight: 34, fontWeight: "600" as const },
};
