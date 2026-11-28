import { NativeModule, requireNativeModule } from "expo-modules-core";

declare class Notify extends NativeModule {
  /**
   * This phone's notification key N (X25519, base64), made the first time and kept in the Keychain group the
   * extension shares, with this phone's device id and the words the extension shows (app/shared/away.ts PUSH_WORDS).
   */
  key(device: string, words: Record<string, string>): Promise<string>;
}

export default requireNativeModule<Notify>("Notify");
