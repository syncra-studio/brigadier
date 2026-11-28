import { CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Button } from "../Button";
import { page } from "../Notice";
import { color, text } from "../theme";

/** The QR scanner. `sample` draws it without the camera, for simulator screenshots. */
export function Scan({ onScanned, onBack, sample }: { onScanned: (url: string) => void; onBack: () => void; sample?: boolean }) {
  const [permission, request] = useCameraPermissions();
  const done = useRef(false);
  useEffect(() => {
    if (!sample && permission && !permission.granted && permission.canAskAgain) void request();
  }, [permission]);
  const denied = !sample && permission && !permission.granted && !permission.canAskAgain;
  return (
    <View style={styles.page}>
      <Text style={styles.title}>Scan the code on your Mac</Text>
      <View style={styles.frame}>
        {!sample && permission?.granted && (
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => {
              if (done.current) return;
              done.current = true;
              onScanned(data);
            }}
          />
        )}
        {denied && <Text style={styles.body}>Brigadier may not use the camera. Allow it in Settings › Brigadier, or enter the code instead.</Text>}
      </View>
      <Button title="Back" onPress={onBack} secondary />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { ...page, gap: 24 },
  title: { ...text.pageTitle, color: color.foreground },
  frame: { flex: 1, borderRadius: 24, overflow: "hidden", backgroundColor: color.surfaceUnder, justifyContent: "center", padding: 24 },
  body: { ...text.base, color: color.mutedForeground, textAlign: "center" },
});
