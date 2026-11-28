import { Pressable, StyleSheet, Text } from "react-native";
import { Spinner } from "../../app/ui/src/icons";
import { Spin } from "./compose/motion";
import { color, fontWeight, opacity, radius, space, spacing, text, touch } from "./theme";

export function Button({ title, onPress, secondary, disabled }: { title: string; onPress?: () => void; secondary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [styles.button, secondary && styles.secondary, (pressed || disabled) && { opacity: disabled ? 0.4 : 0.8 }]}
    >
      <Text style={[styles.title, secondary && { color: color.foreground }]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { backgroundColor: color.primary, borderRadius: 999, paddingVertical: 14, alignItems: "center" },
  secondary: { backgroundColor: color.muted },
  title: { ...text.base, fontWeight: "600", color: color.primaryFg },
  dialog: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space(1.5), height: spacing.controlMd, paddingHorizontal: space(3.5), borderRadius: radius.capsule },
  dialogText: { ...text.sm, fontWeight: fontWeight.medium },
});

const VARIANTS = {
  default: { backgroundColor: color.primary, color: color.primaryFg },
  secondary: { backgroundColor: color.muted, color: color.foreground },
  ghost: { backgroundColor: undefined, color: color.foreground },
  destructive: { backgroundColor: color.destructiveFill, color: color.foreground },
};

/**
 * The desktop's Button at its md size (components/button.tsx): a capsule control-md tall, its words text-sm medium; a
 * finger's 44 round it. `busy`: the confirm's spinner before its words, and off.
 */
export function DialogButton({ title, variant = "default", disabled = false, busy = false, onPress }: { title: string; variant?: keyof typeof VARIANTS; disabled?: boolean; busy?: boolean; onPress: () => void }) {
  const look = VARIANTS[variant];
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
      disabled={off}
      onPress={onPress}
      hitSlop={(touch - spacing.controlMd) / 2}
      style={({ pressed }) => [styles.dialog, { backgroundColor: pressed && variant === "ghost" ? color.fill : look.backgroundColor }, off && { opacity: opacity.disabled }]}
    >
      {busy ? <Spin><Spinner className="size-icon-xs" color={look.color} /></Spin> : null}
      <Text style={[styles.dialogText, { color: look.color }]}>{title}</Text>
    </Pressable>
  );
}
