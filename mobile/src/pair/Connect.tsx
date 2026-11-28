import { StyleSheet, Text, View } from "react-native";
import { Button } from "../Button";
import { color, text } from "../theme";

/** The first screen: pairing starts on the Mac, in Settings › Connections. */
export function Connect({ onScan, onCode, onBack }: { onScan?: () => void; onCode?: () => void; onBack?: () => void }) {
  return (
    <View style={styles.page}>
      <View style={styles.top}>
        <Text style={styles.title}>Connect your Mac</Text>
        <Text style={styles.body}>
          On your Mac, open Brigadier › Settings › Connections and choose Add. Then scan the code it shows, or type it.
        </Text>
      </View>
      <View style={styles.actions}>
        <Button title="Scan QR code" onPress={onScan} />
        <Button title="Enter code manually" onPress={onCode} secondary />
        {onBack && <Button title="Back" onPress={onBack} secondary />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.background, padding: 24, paddingTop: 120, justifyContent: "space-between" },
  top: { gap: 12 },
  title: { ...text.pageTitle, color: color.foreground },
  body: { ...text.base, color: color.mutedForeground },
  actions: { gap: 12, paddingBottom: 32 },
});
