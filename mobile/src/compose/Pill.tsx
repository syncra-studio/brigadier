// The composer footer's pills, as the desktop's composer.tsx ComposerPill and PillDivider: muted words and an icon on a
// capsule that fills only while pressed or open, 28 tall with a reach a finger can hit.
import type { ReactNode } from "react";
import { Pressable, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { color, spacing, opacity, touch } from "../theme";

export function Pill({ label, open, disabled, selected, style, onPress, children }: { label: string; open?: boolean; disabled?: boolean; selected?: boolean; style?: StyleProp<ViewStyle>; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected, expanded: open }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={{ top: (touch - spacing.controlSm) / 2, bottom: (touch - spacing.controlSm) / 2, left: 2, right: 2 }}
      style={({ pressed }) => [st.pill, (pressed || open) && { backgroundColor: color.fill }, style, disabled && { opacity: opacity.disabled }]}
    >
      {children}
    </Pressable>
  );
}

/** The hairline between the footer's pills. */
export const PillDivider = () => <View style={st.divider} />;

const st = StyleSheet.create({
  pill: { height: spacing.controlSm, flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 999, paddingHorizontal: 8, flexShrink: 1, minWidth: 0 },
  divider: { marginHorizontal: 4, height: spacing.iconMd, width: 1, backgroundColor: color.input },
});
