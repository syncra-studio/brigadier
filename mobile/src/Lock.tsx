import { useEffect } from "react";
import Link from "../modules/link";
import { DialogButton } from "./Button";
import { Screen } from "./Notice";

/** The Face ID lock the app opens behind. */
export function Lock({ onUnlock }: { onUnlock: () => void }) {
  const ask = () => Link.unlock("Unlock Brigadier").then((ok) => ok && onUnlock());
  useEffect(() => void ask(), []);
  return <Screen title="Brigadier is locked" actions={<DialogButton title="Unlock" onPress={ask} />} />;
}
