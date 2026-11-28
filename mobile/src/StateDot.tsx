// A small round dot before a line, as the desktop's components/state-dot.tsx: a state's tone, ready, needing a step or off.
import { View } from "react-native";
import { color, radius, space } from "./theme";

const TONES = { ready: color.success, needs: color.warning, off: color.mutedForeground };

export const StateDot = ({ tone = "off" }: { tone?: keyof typeof TONES }) => (
  <View accessible={false} style={{ width: space(1.5), height: space(1.5), borderRadius: radius.capsule, backgroundColor: TONES[tone] }} />
);
