import { useRef, useState } from "react";
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Frame } from "../../vendor/brigadier-shared/client";
import { Button } from "../Button";
import { color, text } from "../theme";
import { signed } from "./act";

/**
 * The one sheet before every fresh signature (lasting answers, starts, the powers): what will happen, the exact
 * command or path whole, then Face ID. `onDone` gets the Mac's reply, or null when cancelled here.
 */
export function Confirm({ title, body, shown, args, onDone }: {
  title: string;
  body?: string;
  /** Shown whole and as is: the `!` line, the resolved path, or the answer. */
  shown: string;
  args: string[];
  onDone: (reply: Frame | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Taps before the spinner shows don't start a second signature.
  const going = useRef(false);
  async function go() {
    if (going.current) return;
    going.current = true;
    setBusy(true);
    setError(null);
    const reply = await signed(args);
    going.current = false;
    setBusy(false);
    // Nothing was sent: the sheet stays, so the user can try again or cancel.
    if (reply.error === "cancelled") return setError("Face ID didn't confirm it. Nothing was sent.");
    if (reply.error === "notSigned") return setError("This iPhone couldn't sign it. Nothing was sent.");
    onDone(reply);
  }
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { if (!busy) onDone(null); }}>
      <View style={styles.page}>
        <View style={styles.top}>
          <Text style={styles.title}>{title}</Text>
          {body && <Text style={styles.body}>{body}</Text>}
          <ScrollView style={styles.box} contentContainerStyle={{ padding: 12 }}>
            <Text selectable style={styles.mono}>{shown}</Text>
          </ScrollView>
          {error && <Text style={styles.body}>{error}</Text>}
        </View>
        <View style={styles.bottom}>
          {busy ? <ActivityIndicator color={color.foreground} /> : <Button title="Confirm with Face ID" onPress={go} />}
          <Button title="Cancel" secondary disabled={busy} onPress={() => onDone(null)} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.background, padding: 24, justifyContent: "space-between" },
  top: { gap: 16, flexShrink: 1 },
  title: { ...text.pageTitle, color: color.foreground },
  body: { ...text.base, color: color.mutedForeground },
  box: { backgroundColor: color.surfaceUnder, borderRadius: 12, borderWidth: 1, borderColor: color.border, maxHeight: 320 },
  mono: { ...text.sm, color: color.foreground, fontFamily: "Menlo" },
  bottom: { gap: 12, paddingBottom: 32 },
});
