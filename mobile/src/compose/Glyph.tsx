// The composer's icons, after the desktop's (app/ui/src/icons). The phone has no icon set and nothing that draws SVG,
// so each is a glyph of the system font where one reads as the desktop's, and drawn with Views where none does.
import { type ReactNode, useEffect, useRef } from "react";
import { ActivityIndicator, Animated, type ColorValue, type StyleProp, Text, type TextStyle, View } from "react-native";
import { color as palette, size as sizes } from "../theme";

/** Text presentation (U+FE0E) where a glyph has an emoji one too. */
const GLYPHS = {
  plus: "+",
  arrowUp: "↑",
  stop: "■",
  play: "▶\uFE0E",
  moon: "☾",
  bolt: "ϟ",
  dots: "⋯",
  steer: "↪\uFE0E",
  check: "✓",
  star: "☆",
  starFilled: "★",
  x: "✕",
  chevronDown: "⌄",
  queue: "▸",
  search: "⌕",
  warning: "⚠\uFE0E",
  photo: "▣",
  document: "▤",
  image: "▨",
  file: "▢",
  comment: "❝",
  sparkles: "✦",
  xCircle: "⊗",
};
export type GlyphName = keyof typeof GLYPHS;

/** A glyph in a box of `size`, as the desktop's `size-icon-*`. */
export function Glyph({ name, size = sizes.iconMd, color = palette.foreground, weight, label }: { name: GlyphName; size?: number; color?: ColorValue; weight?: "400" | "600" | "700"; /** What a screen reader says for it; none, it's left out. */ label?: string }) {
  return (
    <Text allowFontScaling={false} accessible={label !== undefined} accessibilityLabel={label} importantForAccessibility={label ? "yes" : "no-hide-descendants"} style={{ width: size + 2, fontSize: size, lineHeight: size + 2, color, textAlign: "center", fontWeight: weight }}>
      {GLYPHS[name]}
    </Text>
  );
}

/** A square with rounded corners holding a short mark: a command's `/`, the shell's `>_`, a file's kind. */
export function Boxed({ mark, size = sizes.iconMd, color = palette.foreground }: { mark: string; size?: number; color?: ColorValue }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 4, borderWidth: 1.3, borderColor: color, alignItems: "center", justifyContent: "center" }}>
      <Text allowFontScaling={false} style={{ fontSize: size * 0.5, lineHeight: size * 0.6, fontWeight: "700", color, fontFamily: "Menlo" }}>{mark}</Text>
    </View>
  );
}

/** The level icons' shield (ShieldTerminal, ShieldExclamation), and Ask's hand as an open one: `mark` inside. */
export function Shield({ mark, size = sizes.iconMd, color = palette.foreground }: { mark?: string; size?: number; color?: ColorValue }) {
  const w = size * 0.8;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: w, height: size * 0.92, borderWidth: 1.3, borderColor: color, borderTopLeftRadius: 2, borderTopRightRadius: 2, borderBottomLeftRadius: w / 2, borderBottomRightRadius: w / 2, alignItems: "center", justifyContent: "center" }}>
        {mark ? <Text allowFontScaling={false} style={{ fontSize: size * 0.55, lineHeight: size * 0.6, fontWeight: "700", color }}>{mark}</Text> : null}
      </View>
    </View>
  );
}

/** The Trash icon: a lid over a can. */
export function Trash({ size = sizes.iconMd, color = palette.foreground }: { size?: number; color?: ColorValue }) {
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center", gap: 1 }}>
      <View style={{ width: size * 0.75, height: 1.4, borderRadius: 1, backgroundColor: color }} />
      <View style={{ width: size * 0.55, height: size * 0.62, borderWidth: 1.3, borderTopWidth: 0, borderColor: color, borderBottomLeftRadius: 2, borderBottomRightRadius: 2 }} />
    </View>
  );
}

/** The Spinner icon: the system's own. */
export const Spinner = ({ color = palette.foreground }: { color?: ColorValue }) => <ActivityIndicator size="small" color={color} style={{ transform: [{ scale: 0.7 }] }} />;

/** An opacity that pulses while it's in use, as the desktop's `shimmer` and `animate-pulse`. */
export function usePulse() {
  const glow = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([Animated.timing(glow, { toValue: 0.4, duration: 700, useNativeDriver: true }), Animated.timing(glow, { toValue: 1, duration: 700, useNativeDriver: true })]));
    loop.start();
    return () => loop.stop();
  }, []);
  return glow;
}

/** Words that pulse while something is under way ("Deciding", "Optimizing context…"). */
export function Shimmer({ style, children }: { style?: StyleProp<TextStyle>; children: string }) {
  return <Animated.Text numberOfLines={1} style={[style, { opacity: usePulse() }]}>{children}</Animated.Text>;
}

/** Fades in once as it comes, as the desktop's `animate-fade-in`. */
export function FadeIn({ children }: { children: ReactNode }) {
  const shown = useRef(new Animated.Value(0)).current;
  useEffect(() => Animated.timing(shown, { toValue: 1, duration: 150, useNativeDriver: true }).start(), []);
  return <Animated.View style={{ opacity: shown }}>{children}</Animated.View>;
}
