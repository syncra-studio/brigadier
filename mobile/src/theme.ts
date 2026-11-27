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
};

export const text = {
  sm: { fontSize: 14, lineHeight: 20 },
  base: { fontSize: 15, lineHeight: 24 },
  lg: { fontSize: 17, lineHeight: 26 },
  pageTitle: { fontSize: 28, lineHeight: 34, fontWeight: "600" as const },
};
