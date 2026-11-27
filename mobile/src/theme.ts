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
};

export const mono = "Menlo";

export const text = {
  sm: { fontSize: 14, lineHeight: 20 },
  base: { fontSize: 15, lineHeight: 24 },
  lg: { fontSize: 17, lineHeight: 26 },
  pageTitle: { fontSize: 28, lineHeight: 34, fontWeight: "600" as const },
};
