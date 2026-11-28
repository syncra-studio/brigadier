// Notifications from each Mac (relay-wire rev 4): this phone's APNs token and its notification key N go to the Mac it
// signed in to, which seals each notice to N for this phone alone. Asked for once, at the first sign-in.
import * as Notifications from "expo-notifications";
import Link from "../modules/link";
import Notify from "../modules/notify";
import { PUSH_WORDS } from "../../app/shared/away";
import { ask } from "./link";

/** The native APNs token, not Expo's service. A failure only leaves this Mac without notifications. */
export async function register(pk: string) {
  try {
    const asked = await Notifications.getPermissionsAsync();
    const granted = asked.granted || (asked.canAskAgain && (await Notifications.requestPermissionsAsync()).granted);
    const device = (await Link.macs()).find((m) => m.pk === pk)?.device;
    if (!granted || !device) return;
    const [token, n] = await Promise.all([Notifications.getDevicePushTokenAsync(), Notify.key(device, PUSH_WORDS)]);
    await ask({ op: "push", n, token: String(token.data) });
  } catch (e) {
    console.warn("notifications:", e);
  }
}
