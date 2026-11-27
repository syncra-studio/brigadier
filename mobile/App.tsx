import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import Link from "./modules/link";
import { Lock } from "./src/Lock";
import { Connect } from "./src/pair/Connect";

export default function App() {
  // `-screen <name>` opens one screen directly, for simulator screenshots (the simulator has no Face ID).
  const [unlocked, setUnlocked] = useState(Link.screen !== null && Link.screen !== "lock");
  return (
    <>
      <StatusBar style="light" />
      {unlocked ? <Connect /> : <Lock onUnlock={() => setUnlocked(true)} />}
    </>
  );
}
