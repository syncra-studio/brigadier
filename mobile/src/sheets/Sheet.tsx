// A sheet over the thread: the desktop's dialog card (components/dialog.tsx, confirm-dialog.tsx) as a phone's bottom
// sheet: its title and line, what it shows scrolling under them, its buttons at the end, ✕ in the corner. And a menu
// (components/menu.tsx) as a bottom sheet: the desktop's menu surface, its rows a finger tall. Both see-through over a
// blur, as the desktop's [D109].
import { BlurView } from "expo-blur";
import type { ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { X } from "../../../app/ui/src/icons";
import { color, fontWeight, opacity, radius, shadow, space, spacing, text, touch } from "../theme";

export function Sheet({ title, description, footer, onClose, children }: { title: string; description?: ReactNode; /** The dialog's footer: Cancel and its action. */ footer?: ReactNode; onClose: () => void; children?: ReactNode }) {
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable accessibilityLabel="Close" style={[StyleSheet.absoluteFill, st.backdrop]} onPress={onClose} />
      <KeyboardAvoidingView behavior="padding" style={st.sheetArea} pointerEvents="box-none">
        <SafeAreaView edges={["bottom"]} style={st.dialog}>
          <Blur />
          <ScrollView style={st.page} contentContainerStyle={st.card} keyboardShouldPersistTaps="handled">
            <View style={st.header}>
              <Text style={st.title}>{title}</Text>
              {description ? <Text style={st.description}>{description}</Text> : null}
            </View>
            {children}
            {footer ? <View style={st.footer}>{footer}</View> : null}
          </ScrollView>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={({ pressed }) => [st.close, { opacity: pressed ? 1 : opacity.dialogClose }]}>
            <X className="size-icon-md text-foreground" />
          </Pressable>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * A menu from the bottom: the desktop's DropdownMenuContent over the dimmed thread; a tap outside closes it.
 * `onDismiss`: it has gone (`visible` false), so a sheet may open in its place.
 */
export function MenuSheet({ visible = true, onClose, onDismiss, children }: { visible?: boolean; onClose: () => void; onDismiss?: () => void; children: ReactNode }) {
  const { height } = useWindowDimensions();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} onDismiss={onDismiss}>
      <Pressable accessibilityLabel="Close" style={[StyleSheet.absoluteFill, st.backdrop]} onPress={onClose} />
      <SafeAreaView edges={["bottom"]} style={st.menuArea} pointerEvents="box-none">
        {/* A long one (the rewind list at a large text size) scrolls rather than leaving rows off screen. */}
        <ScrollView style={[st.menu, { maxHeight: height * 0.7 }]} contentContainerStyle={st.menuIn} bounces={false}>
          <Blur />
          {children}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

/**
 * The blur under a see-through surface, filling it; the surface's own fill is the tint (bg-material, bg-menu).
 * UIKit takes no radius (theme.css's --blur-material, --blur-popover): its thinnest dark material in full is the nearest.
 */
export const Blur = () => <BlurView intensity={100} tint="systemUltraThinMaterialDark" style={StyleSheet.absoluteFill} />;

/** A menu's row, the desktop's DropdownMenuItem with its MenuRow: a 16 icon in grey, its title, a hint at its end. */
export function MenuItem({ icon, title, hint, disabled, onPress }: { icon?: ReactNode; title: string; hint?: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="menuitem" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [st.item, pressed && { backgroundColor: color.fill }, disabled && { opacity: opacity.disabled }]}>
      {icon !== undefined ? <View style={st.icon}>{icon}</View> : null}
      <Text style={st.itemText} numberOfLines={1}>{title}</Text>
      {hint ? <Text style={st.hint} numberOfLines={1}>{hint}</Text> : null}
    </Pressable>
  );
}

/** The desktop's DropdownMenuLabel, `variant="heading"`: plain grey words over a group. */
export const MenuLabel = ({ children }: { children: string }) => <Text style={st.label}>{children}</Text>;
/** The desktop's DropdownMenuSeparator. */
export const MenuSeparator = () => <View style={st.separator} />;

/** One row of the desktop's card (panel/source/rows.tsx Line): an icon in a 20 wide slot, its words, what ends them; a finger tall. */
export function Line({ icon, end, onPress, label, children }: { icon?: ReactNode; end?: ReactNode; onPress?: () => void; label?: string; children: ReactNode }) {
  const row = (
    <>
      <View style={st.slot}>{icon}</View>
      <View style={{ flex: 1 }}>{children}</View>
      {end}
    </>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [st.line, pressed && { backgroundColor: color.summaryRowHover }]}>{row}</Pressable>
  ) : (
    <View accessibilityLabel={label} style={st.line}>{row}</View>
  );
}

// The ✕ a finger's size round the desktop's 16 at end-4 top-4.
const CLOSE_AT = space(4) - (touch - spacing.iconMd) / 2;

export const st = StyleSheet.create({
  // The desktop's dialog-card from the bottom, as tall as it needs: rounded-sheet, shadow-material, bg-material over a blur.
  sheetArea: { flex: 1, justifyContent: "flex-end", padding: space(2) },
  dialog: { maxHeight: "92%", borderRadius: radius.sheet, backgroundColor: color.material, boxShadow: shadow.material, overflow: "hidden" },
  page: { flexGrow: 0 },
  card: { padding: space(5), gap: space(4) },
  header: { gap: space(2), paddingEnd: touch },
  title: { ...text.base, lineHeight: text.base.fontSize, fontWeight: fontWeight.medium, color: color.foreground },
  description: { ...text.sm, color: color.mutedForeground },
  footer: { flexDirection: "row", justifyContent: "flex-end", gap: space(2) },
  close: { position: "absolute", top: CLOSE_AT, end: CLOSE_AT, width: touch, height: touch, alignItems: "center", justifyContent: "center" },
  // What a dialog's parts show: a section's heading, its lines, a note, a red line, blue words that act.
  heading: { ...text.sm, fontWeight: fontWeight.medium, color: color.foreground },
  body: { ...text.sm, color: color.foreground },
  muted: { ...text.sm, color: color.mutedForeground },
  note: { ...text.xs, color: color.mutedForeground },
  error: { ...text.xs, color: color.destructive },
  link: { ...text.sm, color: color.link },
  backdrop: { backgroundColor: color.dialogBackdrop },
  menuArea: { flex: 1, justifyContent: "flex-end", padding: space(2) },
  // bg-menu over a blur.
  menu: { flexGrow: 0, borderRadius: radius.menu, backgroundColor: color.menu, boxShadow: shadow.overlay },
  menuIn: { padding: space(1) },
  item: { flexDirection: "row", alignItems: "center", gap: space(2), minHeight: touch, paddingHorizontal: space(2), borderRadius: radius.menuItem },
  icon: { width: spacing.iconMd, alignItems: "center", justifyContent: "center" },
  itemText: { ...text.label, color: color.foreground, flex: 1 },
  hint: { ...text.xs, color: color.mutedForeground, flexShrink: 1 },
  label: { ...text.sm, color: color.mutedForeground, paddingVertical: space(1.5), paddingHorizontal: space(2) },
  line: { flexDirection: "row", alignItems: "center", gap: space(2), minHeight: touch, paddingHorizontal: space(2), borderRadius: radius.sm },
  slot: { minWidth: space(5), alignItems: "center", justifyContent: "center" },
  lineText: { ...text.label, color: color.foreground },
  separator: { height: 1, marginHorizontal: space(1), marginVertical: space(1), backgroundColor: color.border },
});
