// Images a reply names by their path on the Mac (msgs/remote-wire.md, `attach <id> view`): one in the session's
// checkout comes as asked; any other only as its own resolved path, shown whole and signed with Face ID (power
// `paths`, D57). The Mac's copy then comes through `attachment`, drawn under the reply.
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Confirm } from "../act/Confirm";
import { forMac } from "../compose/state";
import { thread } from "../mac/mac";
import { forgetImage, ThreadImage } from "../thread/Image";
import { ViewImage } from "../thread/Markdown";
import { color, text } from "../theme";
import { refusal } from "./powers";

/** A path asked: being read, to sign, shown (the Mac's copy's id), or refused in the Mac's words. */
type Viewed = { path: string; sign?: string; id?: string; error?: string };

/** The reply's text with its images' paths to tap, and each one tapped under it. */
export function ReplyImages({ children }: { children: ReactNode }) {
  const { run } = forMac();
  const owner = useSyncExternalStore(thread.subscribe, () => thread.get()?.id);
  const [shown, setShown] = useState<Viewed[]>([]);
  const set = (path: string, next: Omit<Viewed, "path">) => setShown((now) => now.map((each) => (each.path === path ? { path, ...next } : each)));
  /** The Mac's answer to `attach … view`: a path to sign comes back once; never one it turned down by its words. */
  const answered = (path: string, sent: string, signed: boolean) => (reply: Record<string, any>) => {
    if (reply.ok) {
      forgetImage(owner!, reply.id);
      return set(path, { id: reply.id });
    }
    if (reply.error === "not_canonical" && typeof reply.path === "string") return set(path, { sign: reply.path });
    // An absolute path already in its resolved form.
    if (!signed && reply.error === "Needs Face ID" && sent.startsWith("/")) return set(path, { sign: sent });
    set(path, { error: refusal(reply) });
  };
  const view = (path: string) => {
    if (!owner) return;
    setShown((now) => [...now.filter((each) => each.path !== path), { path }]);
    void run(["attach", owner, "view", path]).then(answered(path, path, false));
  };
  const signing = shown.find((each) => each.sign);
  return (
    <ViewImage.Provider value={owner ? view : null}>
      {children}
      {shown.map((each) => (
        <View key={each.path} style={st.viewed}>
          {each.id ? (
            <ThreadImage owner={owner} attachment={each.id} label={each.path} style={st.image} whole />
          ) : each.error ? (
            <Text style={st.error}>{each.error}</Text>
          ) : (
            <ActivityIndicator color={color.mutedForeground} style={{ alignSelf: "flex-start" }} />
          )}
          <Text style={st.name} numberOfLines={1}>{each.path.split("/").pop()}</Text>
        </View>
      ))}
      {signing && owner ? (
        <Confirm
          title="Show this image?"
          body="It's outside this session's project, so this iPhone reads it only with Face ID."
          shown={signing.sign!}
          args={["attach", owner, "view", signing.sign!]}
          onDone={(reply) => (reply ? answered(signing.path, signing.sign!, true)(reply) : setShown((now) => now.filter((each) => each.path !== signing.path)))}
        />
      ) : null}
    </ViewImage.Provider>
  );
}

const st = StyleSheet.create({
  viewed: { gap: 4 },
  image: { width: "100%", aspectRatio: 4 / 3, borderRadius: 10 },
  name: { fontSize: 12, color: color.mutedForeground },
  error: { ...text.sm, color: color.destructive },
});
