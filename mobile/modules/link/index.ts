import { requireNativeModule } from "expo-modules-core";

type Link = {
  /** A screen to open at launch, from the `-screen` launch argument (simulator screenshots only). */
  screen: string | null;
  /** Face ID (or the passcode if Face ID is unavailable); false when cancelled. */
  unlock(reason: string): Promise<boolean>;
};

export default requireNativeModule<Link>("Link");
