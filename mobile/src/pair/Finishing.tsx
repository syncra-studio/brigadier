import { ActivityIndicator, StyleSheet, Text } from "react-native";
import { checkWords } from "../../../app/shared/words";
import { DialogButton } from "../Button";
import { Screen } from "../Notice";
import { color, mono, text, tracking } from "../theme";

/** While the Mac asks its owner: the 6 digits both sides show, once the phone has signed, as the Mac's check step shows them. */
export function Finishing({ check, onCancel }: { check?: string; onCancel: () => void }) {
  return (
    <Screen
      title="Finishing secure setup…"
      line={check ? "Check that your Mac shows the same 6 digits, then click Allow there." : undefined}
      actions={<DialogButton title="Cancel" variant="secondary" onPress={onCancel} />}
    >
      {check ? (
        <Text style={styles.digits} accessibilityLabel={check.split("").join(" ")}>
          {checkWords(check)}
        </Text>
      ) : (
        <ActivityIndicator color={color.foreground} />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  // font-mono text-page-title tracking-widest.
  digits: { ...text.pageTitle, fontFamily: mono, letterSpacing: tracking.widest * text.pageTitle.fontSize, color: color.foreground, textAlign: "center" },
});
