import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { page } from "../Notice";
import { color, text } from "../theme";

/** While the Mac asks its owner: the 6 digits both sides show, once the phone has signed. */
export function Finishing({ check }: { check?: string }) {
  return (
    <View style={styles.page}>
      <Text style={styles.title}>Finishing secure setup…</Text>
      {check ? (
        <>
          <Text style={styles.digits} accessibilityLabel={check.split("").join(" ")}>
            {`${check.slice(0, 3)} ${check.slice(3)}`}
          </Text>
          <Text style={styles.body}>Check that your Mac shows the same 6 digits, then click Allow there.</Text>
        </>
      ) : (
        <ActivityIndicator color={color.foreground} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { ...page, gap: 24 },
  title: { ...text.pageTitle, color: color.foreground },
  digits: { fontSize: 44, lineHeight: 52, fontWeight: "600", color: color.foreground, fontVariant: ["tabular-nums"], letterSpacing: 4 },
  body: { ...text.base, color: color.mutedForeground },
});
