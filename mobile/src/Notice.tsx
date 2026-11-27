import { StyleSheet, Text, View } from "react-native";
import { Button } from "./Button";
import type { Problem } from "./pair/pair";
import { color, text } from "./theme";

export const PROBLEMS: Record<Problem, { title: string; body: string }> = {
  expired: { title: "This code can't be used", body: "It has expired or was already used. On your Mac, choose Add again for a new one." },
  reused: {
    title: "Pairing stopped",
    body: "This code was used again, so your Mac stopped pairing to keep it safe. On your Mac, choose Add again for a new one.",
  },
  denied: { title: "Your Mac didn't allow this iPhone", body: "If that was a mistake, choose Add on your Mac and pair again." },
  unreachable: {
    title: "Can't reach your Mac",
    body: "Make sure this iPhone is on the same Wi-Fi as your Mac, and that Brigadier may use the local network (Settings › Brigadier).",
  },
  noOffer: {
    title: "No Mac is waiting for a code",
    body: "On your Mac, open Brigadier › Settings › Connections, choose Add, then Enter code manually.",
  },
  wrongCode: { title: "That code didn't match", body: "Check the 16 characters your Mac shows and try again." },
  notPaired: { title: "Your Mac doesn't know this iPhone any more", body: "Its access may have been revoked. Forget this Mac and pair again." },
  updatePhone: { title: "Update Brigadier on this iPhone", body: "Your Mac runs a newer Brigadier than this app. Install the latest build from TestFlight." },
  updateMac: { title: "Update Brigadier on your Mac", body: "This app is newer than your Mac's Brigadier. Update Brigadier on your Mac, then try again." },
  lost: { title: "The connection was lost", body: "Try again in a moment." },
  badQr: { title: "That isn't a Brigadier code", body: "Scan the code in Brigadier › Settings › Connections on your Mac." },
};

/** A whole-screen message with one way on. */
export function Notice({ title, body, action, onPress }: { title: string; body: string; action: string; onPress: () => void }) {
  return (
    <View style={styles.page}>
      <View style={styles.top}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>{body}</Text>
      </View>
      <Button title={action} onPress={onPress} />
    </View>
  );
}

export const page = { flex: 1, backgroundColor: color.background, padding: 24, paddingTop: 120, paddingBottom: 56 } as const;

const styles = StyleSheet.create({
  page: { ...page, justifyContent: "space-between" },
  top: { gap: 12 },
  title: { ...text.pageTitle, color: color.foreground },
  body: { ...text.base, color: color.mutedForeground },
});
