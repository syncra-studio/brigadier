import { useState } from "react";
import { StyleSheet, TextInput } from "react-native";
import { codeWords, CONNECTION_WORDS } from "../../../app/shared/words";
import { DialogButton } from "../Button";
import { Screen } from "../Notice";
import { color, mono, radius, space, spacing, text, touch, tracking } from "../theme";
import { readCode } from "./pair";

/** Enter code manually: the 16 characters the Mac shows, in the desktop's Input, typed as the Mac shows them (font-mono tracking-wider). */
export function Code({ onCode, onBack }: { onCode: (code: string) => void; onBack: () => void }) {
  const [typed, setTyped] = useState("");
  const code = readCode(typed);
  return (
    <Screen
      title={CONNECTION_WORDS.enterCode}
      line="Type the 16 characters your Mac shows. Dashes and spaces don't matter."
      actions={
        <>
          <DialogButton title="Back" variant="secondary" onPress={onBack} />
          <DialogButton title="Connect" onPress={() => code && onCode(code)} disabled={!code} />
        </>
      }
    >
      <TextInput
        style={styles.input}
        value={typed}
        onChangeText={setTyped}
        autoCapitalize="characters"
        autoCorrect={false}
        autoFocus
        placeholder={codeWords("XXXXXXXXXXXXXXXX")}
        placeholderTextColor={color.mutedForeground}
        hitSlop={(touch - spacing.controlMd) / 2}
        onSubmitEditing={() => code && onCode(code)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  // components/input.tsx: h-control-md rounded-capsule bg-fill px-3.5 text-sm.
  // Its size alone: a line height moves a one-line field's words off centre on iOS.
  input: {
    fontSize: text.sm.fontSize,
    minHeight: spacing.controlMd,
    paddingHorizontal: space(3.5),
    borderRadius: radius.capsule,
    backgroundColor: color.fill,
    color: color.foreground,
    fontFamily: mono,
    letterSpacing: tracking.wider * text.sm.fontSize,
  },
});
