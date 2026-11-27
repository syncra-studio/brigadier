import { DarkTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useSyncExternalStore } from "react";
import { Pressable, Text } from "react-native";
import { Sessions } from "../lists/Sessions";
import { Samples } from "../samples/Samples";
import { color, text } from "../theme";
import { Thread } from "../thread/Thread";
import { closeThread, lists, openThread } from "./mac";

type Screens = { sessions: undefined; thread: { id: string; title: string }; samples: undefined };
const Stack = createNativeStackNavigator<Screens>();

const theme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: color.background, card: color.background, text: color.foreground, border: color.border, primary: color.primary } };

/** A signed-in Mac: its sessions, a session's thread, and the samples screen. */
/** `open`: a screen to start on (simulator screenshots only). */
export function MacScreens({ name, onMacs, open }: { name: string; onMacs: () => void; open?: "thread" | "samples" }) {
  const ready = useSyncExternalStore(lists.subscribe, () => lists.get().ready);
  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator initialRouteName={open ?? "sessions"} screenOptions={{ headerShadowVisible: false }}>
        <Stack.Screen
          name="sessions"
          options={{
            title: name,
            // The dot says whether this Mac is connected now, as the Mac list does.
            headerTitle: () => (
              <Text style={{ ...text.lg, fontWeight: "600", color: color.foreground }}>
                <Text style={{ color: ready ? "#3fb950" : color.mutedForeground }}>● </Text>
                {name}
              </Text>
            ),
            headerLeft: () => (
              <Pressable accessibilityRole="button" accessibilityLabel="Your Macs" onPress={onMacs} hitSlop={12}>
                <Text style={{ ...text.base, color: color.foreground }}>Macs</Text>
              </Pressable>
            ),
          }}
        >
          {({ navigation }) => (
            <Sessions
              onOpen={(row) => {
                openThread(row.id);
                navigation.navigate("thread", { id: row.id, title: row.title || "New session" });
              }}
              onSamples={() => navigation.navigate("samples")}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="thread" component={Thread} initialParams={open === "thread" ? { id: "s1", title: "Fix the failing login test" } : undefined} options={({ route }) => ({ title: route.params?.title ?? "" })} listeners={{ beforeRemove: closeThread }} />
        <Stack.Screen name="samples" component={Samples} options={{ title: "Samples" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
