import { Pressable, StyleSheet, Text } from "react-native";
import { color, text } from "./theme";

export function Button({ title, onPress, secondary }: { title: string; onPress?: () => void; secondary?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.button, secondary && styles.secondary, pressed && { opacity: 0.8 }]}
    >
      <Text style={[styles.title, secondary && { color: color.foreground }]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { backgroundColor: color.primary, borderRadius: 999, paddingVertical: 14, alignItems: "center" },
  secondary: { backgroundColor: color.muted },
  title: { ...text.base, fontWeight: "600", color: color.primaryFg },
});
