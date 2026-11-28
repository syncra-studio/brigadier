import { CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { DialogButton } from "../Button";
import { Screen, st } from "../Notice";
import { color, radius, space } from "../theme";

/** The QR scanner, where the Mac's QR step shows its code (size-48 rounded-settings). `sample` draws it without the camera, for simulator screenshots. */
export function Scan({ onScanned, onBack, sample }: { onScanned: (url: string) => void; onBack: () => void; sample?: boolean }) {
  const [permission, request] = useCameraPermissions();
  const done = useRef(false);
  useEffect(() => {
    if (!sample && permission && !permission.granted && permission.canAskAgain) void request();
  }, [permission]);
  const denied = !sample && permission && !permission.granted && !permission.canAskAgain;
  return (
    <Screen title="Scan the code on your Mac" actions={<DialogButton title="Back" variant="secondary" onPress={onBack} />}>
      {denied && <Text style={st.warning}>Brigadier may not use the camera. Allow it in Settings › Brigadier, or enter the code instead.</Text>}
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
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  frame: { alignSelf: "center", width: space(48), height: space(48), borderRadius: radius.settings, overflow: "hidden", backgroundColor: color.surfaceUnder },
});
