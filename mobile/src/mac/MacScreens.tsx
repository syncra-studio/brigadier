import { DarkTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useSyncExternalStore } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import { statusWords } from "../../../app/shared/rows";
import { CHAT_TAB_WORDS } from "../../../app/shared/words";
import { Archive, DotsHorizontal, SidebarError, SidebarWorking } from "../../../app/ui/src/icons";
import { Spin } from "../compose/motion";
import { ProjectBadge, Sessions } from "../lists/Sessions";
import { Samples } from "../samples/Samples";
import { sessionMenu } from "../sheets/Sheets";
import { Start } from "../start/Start";
import { StateDot } from "../StateDot";
import { color, radius, space, text, touch } from "../theme";
import { Thread } from "../thread/Thread";
import { closeThread, lists, openThread } from "./mac";

export type Screens = { sessions: undefined; thread: { id: string; title: string }; samples: undefined; start: { project: string; name: string } };
const Stack = createNativeStackNavigator<Screens>();

const theme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: color.background, card: color.background, text: color.foreground, border: color.border, primary: color.primary } };

/** A signed-in Mac: its sessions, a session's thread, a new chat, and the samples screen. */
/** `open`: a screen to start on (simulator screenshots only). */
export function MacScreens({ name, onMacs, open }: { name: string; onMacs: () => void; open?: "thread" | "samples" | "start" }) {
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
              <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
                <StateDot tone={ready ? "ready" : "off"} />
                <Text style={{ ...text.lg, fontWeight: "600", color: color.foreground }}>{name}</Text>
              </View>
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
                navigation.navigate("thread", { id: row.id, title: row.title });
              }}
              onSamples={() => navigation.navigate("samples")}
              onNew={(project) => navigation.navigate("start", { project: project.id, name: project.name })}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="thread" component={Thread} initialParams={open === "thread" ? { id: "s1", title: "Fix the failing login test" } : undefined} options={({ route }) => ({ title: route.params?.title ?? "", headerTitle: () => (route.params?.id ? <ChatTitle id={route.params.id} title={route.params.title} /> : null) })} listeners={{ beforeRemove: closeThread }} />
        <Stack.Screen name="start" options={{ title: "New chat" }} initialParams={open === "start" ? { project: "p1", name: "brigadier" } : undefined}>
          {({ navigation, route }) => (
            <Start
              project={route.params.project}
              name={route.params.name}
              onStarted={(id, title) => {
                openThread(id);
                navigation.replace("thread", { id, title });
              }}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="samples" component={Samples} options={{ title: "Samples" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

/**
 * The thread's header as the desktop's lone chat tab draws it (shell/chat-tab.tsx, plain): its project's badge, a chat's
 * bubble, the amber ring when it failed or Archive's box; its title, white; then its "…" just after it, the spinner in
 * its square while it works [D196 D200 D287]. iOS centres it, with the back button at the start.
 */
function ChatTitle({ id, title }: { id: string; title: string }) {
  const { rows, projects } = useSyncExternalStore(lists.subscribe, lists.get);
  const { width } = useWindowDimensions();
  const row = rows.find((each) => each.id === id);
  const archived = Boolean(row?.archived);
  // A start Rust hasn't titled yet shows no name for the moment until its title lands [D102].
  const named = (row ? row.title : title) || (row?.state === "starting" ? "" : CHAT_TAB_WORDS.untitled);
  const words = row ? statusWords(row) : null;
  const working = row?.mark === "working" && !archived;
  const icon = archived ? (
    <Archive className="size-icon-md" />
  ) : row?.mark === "amber" ? (
    <View style={{ transform: [{ rotate: "180deg" }] }}><SidebarError className="size-icon-md text-warning" /></View>
  ) : (
    <ProjectBadge project={projects.find((each) => each.id === row?.project)} />
  );
  return (
    // Room for the back button on either side, as iOS centres a title.
    <View style={{ flexDirection: "row", alignItems: "center", gap: space(4), maxWidth: width - 2 * (touch + space(4)) }}>
      {icon}
      <Text accessibilityRole="header" accessibilityLabel={archived ? `${named} (Archived)` : [named, words].filter(Boolean).join(" · ")} style={{ ...text.label, color: color.chatTitle, flexShrink: 1 }} numberOfLines={1}>
        {named}
      </Text>
      {/* Shown for an archived chat too: the phone's sheets are its only way to them (the desktop's tab hides its actions). */}
      <Pressable accessibilityRole="button" accessibilityLabel={CHAT_TAB_WORDS.actions} onPress={() => sessionMenu(id)} hitSlop={(touch - space(7)) / 2} style={({ pressed }) => ({ width: space(7), height: space(7), marginLeft: space(1.75) - space(4), borderRadius: radius.iconButton, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? color.fill : undefined })}>
          {working ? <Spin><SidebarWorking className="size-icon-md text-marker-foreground" /></Spin> : <DotsHorizontal className="size-icon-md text-chat-title" />}
      </Pressable>
    </View>
  );
}
