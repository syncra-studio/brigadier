import type { TextStyle } from "react-native";

/** The desktop's theme tokens (app/ui/src/theme.css `@theme static`) by kind, under their names less the kind. */
declare const theme: {
  color: Record<string, string>;
  /** px; a viewport-relative one (25dvh, min(…)) is a string the phone works out from its window. */
  spacing: Record<string, number>;
  radius: Record<string, number>;
  container: Record<string, number>;
  blur: Record<string, number>;
  text: Record<string, { fontSize: number; lineHeight?: number }>;
  font: Record<string, string[]>;
  fontWeight: Record<string, NonNullable<TextStyle["fontWeight"]>>;
  shadow: Record<string, string>;
  opacity: Record<string, number>;
  leading: Record<string, number>;
  /** em: times the text's size. */
  tracking: Record<string, number>;
  /** ms. */
  duration: Record<string, number>;
  ease: Record<string, string>;
  scale: Record<string, number>;
  /** Overnight's composer card (sessions/overnight.css): its fill and ring, then its glow and stars as layers. */
  night: { card: { backgroundColor: string; boxShadow: string }; glow: { opacity: number; backgroundImage: string }; stars: { opacity: number; backgroundImage: string } };
};
export default theme;
