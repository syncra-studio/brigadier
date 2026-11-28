import { useState } from "react";
import { KeyboardAvoidingView, StyleSheet, Text, TextInput, View } from "react-native";
import { Button } from "../Button";
import { page } from "../Notice";
import { color, text } from "../theme";
import { readCode } from "./pair";

/** Enter code manually: the 16 characters the Mac shows. */
export function Code({ onCode, onBack }: { onCode: (code: string) => void; onBack: () => void }) {
  const [typed, setTyped] = useState("");
  const code = readCode(typed);
  return (
    <KeyboardAvoidingView behavior="padding" style={styles.page}>
      <View style={styles.top}>
        <Text style={styles.title}>Enter code manually</Text>
        <Text style={styles.body}>Type the 16 characters your Mac shows. Dashes and spaces don't matter.</Text>
        <TextInput
          style={styles.input}
          value={typed}
          onChangeText={setTyped}
          autoCapitalize="characters"
          autoCorrect={false}
          autoFocus
          placeholder="XXXX-XXXX-XXXX-XXXX"
          placeholderTextColor={color.mutedForeground}
          onSubmitEditing={() => code && onCode(code)}
        />
      </View>
      <View style={styles.actions}>
        <Button title="Connect" onPress={() => code && onCode(code)} disabled={!code} />
        <Button title="Back" onPress={onBack} secondary />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { ...page, justifyContent: "space-between" },
  top: { gap: 12 },
  title: { ...text.pageTitle, color: color.foreground },
  body: { ...text.base, color: color.mutedForeground },
  input: {
    ...text.lg,
    color: color.foreground,
    backgroundColor: color.surfaceUnder,
    borderColor: color.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    fontVariant: ["tabular-nums"],
    letterSpacing: 1,
  },
  actions: { gap: 12 },
});
