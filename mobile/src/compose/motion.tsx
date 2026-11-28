// The desktop's motion classes the phone draws: animate-spin, shimmer and animate-pulse, animate-fade-in.
import { type ReactNode, useEffect, useRef } from "react";
import { Animated, Easing, type StyleProp, type TextStyle } from "react-native";

/** Turns its icon once a second, as the desktop's `animate-spin` (a Spinner's). */
export function Spin({ children }: { children: ReactNode }) {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, []);
  return <Animated.View style={{ transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] }}>{children}</Animated.View>;
}

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
