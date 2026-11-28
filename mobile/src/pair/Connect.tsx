import { View } from "react-native";
import { CONNECTION_WORDS } from "../../../app/shared/words";
import { DialogButton } from "../Button";
import { Screen, st } from "../Notice";

/** The first screen: pairing starts on the Mac, in Settings › Connections; Enter code manually last, as the Mac's QR step has it. */
export function Connect({ onScan, onCode, onBack }: { onScan?: () => void; onCode?: () => void; onBack?: () => void }) {
  return (
    <Screen title="Connect your Mac" line="On your Mac, open Brigadier › Settings › Connections and choose Add. Then scan the code it shows, or type it.">
      <View style={st.actions}>
        {onBack && <DialogButton title="Back" variant="secondary" onPress={onBack} />}
        <DialogButton title="Scan QR code" onPress={onScan} />
      </View>
      <View style={st.actions}>
        <DialogButton title={CONNECTION_WORDS.enterCode} variant="link-blue" size="inline" onPress={onCode} />
      </View>
    </Screen>
  );
}
