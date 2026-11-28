import { Pressable, StyleSheet, Text } from "react-native";
import { Spinner } from "../../app/ui/src/icons";
import { Spin } from "./compose/motion";
import { color, fontWeight, opacity, radius, space, spacing, text, touch } from "./theme";

// The desktop's VARIANTS (components/button.tsx); `pressed` is its hover fill, for a finger.
const VARIANTS = {
  default: { backgroundColor: color.primary, color: color.primaryFg, pressed: color.primaryHover },
  secondary: { backgroundColor: color.muted, color: color.foreground, pressed: color.popover },
  ghost: { backgroundColor: undefined, color: color.foreground, pressed: color.fill },
  destructive: { backgroundColor: color.destructiveFill, color: color.foreground, pressed: color.destructiveFillHover },
  soft: { backgroundColor: color.fillSubtle, color: color.foreground, pressed: color.fillHover },
  "link-blue": { backgroundColor: undefined, color: color.link, pressed: undefined },
};

// The desktop's SIZES: capsules control-md and control-sm tall, and inline words with no box.
const SIZES = {
  md: { height: spacing.controlMd, paddingHorizontal: space(3.5), gap: space(1.5), borderRadius: radius.capsule },
  sm: { height: spacing.controlSm, paddingHorizontal: space(2.5), gap: space(1), borderRadius: radius.capsule },
  // h-auto: one line of its text-xs.
  inline: { height: text.xs.lineHeight ?? text.xs.fontSize, gap: space(1) },
};

/**
 * The desktop's Button (components/button.tsx) at its md, sm or inline size, its words as its typeClasses set them;
 * a finger's 44 round it. `busy`: the confirm's spinner before its words, and off.
 */
export function DialogButton({ title, variant = "default", size = "md", disabled = false, busy = false, onPress }: { title: string; variant?: keyof typeof VARIANTS; size?: keyof typeof SIZES; disabled?: boolean; busy?: boolean; onPress?: () => void }) {
  const look = VARIANTS[variant];
  const box = SIZES[size];
  const off = disabled || busy;
  const type = size === "inline" ? styles.xs : variant === "soft" ? styles.soft : styles.sm;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
      disabled={off}
      onPress={onPress}
      hitSlop={(touch - box.height) / 2}
      style={({ pressed }) => [styles.button, box, { backgroundColor: (pressed && look.pressed) || look.backgroundColor }, off && { opacity: opacity.disabled }]}
    >
      {busy ? <Spin><Spinner className="size-icon-xs" color={look.color} /></Spin> : null}
      <Text style={[type, { color: look.color }]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  sm: { ...text.sm, fontWeight: fontWeight.medium },
  soft: { ...text.label, fontWeight: fontWeight.normal },
  xs: { ...text.xs, fontWeight: fontWeight.medium },
});
