import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import Link from "../modules/link";
import { Button } from "./Button";
import { color, text } from "./theme";

/** The Face ID lock the app opens behind. */
export function Lock({ onUnlock }: { onUnlock: () => void }) {
  const ask = () => Link.unlock("Unlock Brigadier").then((ok) => ok && onUnlock());
  useEffect(() => void ask(), []);
  return (
    <View style={styles.page}>
      <Text style={styles.title}>Brigadier is locked</Text>
      <View style={styles.bottom}>
        <Button title="Unlock" onPress={ask} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.background, justifyContent: "center", padding: 24 },
  title: { ...text.lg, color: color.foreground, textAlign: "center" },
  bottom: { position: "absolute", left: 24, right: 24, bottom: 56 },
});
