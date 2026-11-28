import type { ReactNode } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from "react-native";
import { DialogButton } from "./Button";
import type { Problem } from "./pair/pair";
import { color, fontWeight, space, text } from "./theme";

export const PROBLEMS: Record<Problem, { title: string; body: string }> = {
  expired: { title: "This code can't be used", body: "It has expired or was already used. On your Mac, choose Add again for a new one." },
  reused: {
    title: "Pairing stopped",
    body: "This code was used again, so your Mac stopped pairing to keep it safe. On your Mac, choose Add again for a new one.",
  },
  denied: { title: "Your Mac didn't allow this iPhone", body: "If that was a mistake, choose Add on your Mac and pair again." },
  unreachable: {
    title: "Can't reach your Mac",
    body: "Check that your Mac is on with Brigadier open. On the same Wi-Fi, Brigadier needs the local network (Settings › Brigadier); away from it, your Mac needs Away from home on (Settings › Connections).",
  },
  noOffer: {
    title: "No Mac is waiting for a code",
    body: "On your Mac, open Brigadier › Settings › Connections, choose Add, then Enter code manually.",
  },
  wrongCode: { title: "That code didn't match", body: "Check the 16 characters your Mac shows and try again." },
  notPaired: {
    title: "Your Mac doesn't know this iPhone any more",
    body: "Its access may have been revoked, or Face ID changed on this iPhone. Forget this Mac and pair again.",
  },
  localNetwork: {
    title: "Brigadier can't use the local network",
    body: "Allow it in Settings › Privacy & Security › Local Network, then try again.",
  },
  updatePhone: { title: "Update Brigadier on this iPhone", body: "Your Mac runs a newer Brigadier than this app. Install the latest build from TestFlight." },
  updateMac: { title: "Update Brigadier on your Mac", body: "This app is newer than your Mac's Brigadier. Update Brigadier on your Mac, then try again." },
  lost: { title: "The connection was lost", body: "Try again in a moment." },
  badQr: { title: "That isn't a Brigadier code", body: "Scan the code in Brigadier › Settings › Connections on your Mac." },
};

/**
 * A pairing step as the whole screen: the desktop's Add dialog (settings/connections.tsx) without its card, as the
 * screen is the dialog: an icon, its Head, what the step shows, then its buttons, centred and 20 apart (gap-5 p-6
 * text-center). A field in it stays above the keyboard; at a Larger Text size it scrolls, clear of the status bar, and its
 * buttons wrap.
 */
export function Screen({ icon, title, line, children, actions }: { icon?: ReactNode; title: string; line?: string; children?: ReactNode; /** The dialog's buttons, secondary first. */ actions?: ReactNode }) {
  return (
    <KeyboardAvoidingView behavior="padding" style={st.fill}>
      <ScrollView contentContainerStyle={st.page} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">
        {icon ? <View style={st.icon}>{icon}</View> : null}
        <View style={st.head}>
          <Text accessibilityRole="header" style={st.title}>{title}</Text>
          {line ? <Text style={st.line}>{line}</Text> : null}
        </View>
        {children}
        {actions ? <View style={st.actions}>{actions}</View> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** A whole-screen message with one way on. */
export function Notice({ icon, title, body, action, onPress }: { icon?: ReactNode; title: string; body: string; action: string; onPress: () => void }) {
  return <Screen icon={icon} title={title} line={body} actions={<DialogButton title={action} onPress={onPress} />} />;
}

export const st = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.background },
  page: { flexGrow: 1, justifyContent: "center", gap: space(5), padding: space(6), backgroundColor: color.background },
  icon: { alignSelf: "center" },
  // Head: the DialogTitle's px-6 text-lg leading-none medium, its DialogDescription text-sm muted, 8 apart.
  head: { gap: space(2) },
  title: { ...text.lg, lineHeight: text.lg.fontSize, fontWeight: fontWeight.medium, color: color.foreground, paddingHorizontal: space(6), textAlign: "center" },
  line: { ...text.sm, color: color.mutedForeground, textAlign: "center" },
  // A warning over what the step shows (text-label text-warning).
  warning: { ...text.label, color: color.warning, textAlign: "center" },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space(2) },
});
