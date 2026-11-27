// Images a reply names by their path on the Mac (msgs/remote-wire.md, `attach <id> view`): one in the session's
// checkout comes as asked; any other only as its own resolved path, shown whole and signed with Face ID (power
// `paths`, D57). The Mac's copy then comes through `attachment`, drawn under the reply.
import { type ReactNode, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Confirm } from "../act/Confirm";
import { forMac } from "../compose/state";
import { thread } from "../mac/mac";
import { forgetImage, ThreadImage } from "../thread/Image";
import { ViewImage } from "../thread/Markdown";
import { color, text } from "../theme";
import { refusal } from "./powers";

/** A path asked (`n`, its newest ask): being read, to sign, shown (the Mac's copy's id), or refused in the Mac's words. */
type Viewed = { path: string; n: number; sign?: string; id?: string; error?: string };

/** The reply's text with its images' paths to tap, and each one tapped under it. */
export function ReplyImages({ children }: { children: ReactNode }) {
  const { run } = forMac();
  const owner = useSyncExternalStore(thread.subscribe, () => thread.get()?.id);
  const [shown, setShown] = useState<Viewed[]>([]);
  const asks = useRef(0);
  // An older ask's answer is dropped: only a path's newest counts.
  const set = (path: string, n: number, next: Omit<Viewed, "path" | "n">) => setShown((now) => now.map((each) => (each.path === path && each.n === n ? { path, n, ...next } : each)));
  /** The Mac's answer to `attach … view`: a path to sign comes back once; never one it turned down by its words. */
  const answered = (path: string, n: number, sent: string, signed: boolean) => (reply: Record<string, any>) => {
    if (reply.ok) {
      forgetImage(owner!, reply.id);
      return set(path, n, { id: reply.id });
    }
    if (reply.error === "not_canonical" && typeof reply.path === "string") return set(path, n, { sign: reply.path });
    // An absolute path already in its resolved form.
    if (!signed && reply.error === "Needs Face ID" && sent.startsWith("/")) return set(path, n, { sign: sent });
    set(path, n, { error: refusal(reply) });
  };
  const view = (path: string) => {
    if (!owner) return;
    const n = ++asks.current;
    setShown((now) => [...now.filter((each) => each.path !== path), { path, n }]);
    void run(["attach", owner, "view", path]).then(answered(path, n, path, false));
  };
  // The sheet's path and command stay as they were till it settles; any other to sign waits its turn.
  const [signing, setSigning] = useState<Viewed | null>(null);
  const next = signing ? null : shown.find((each) => each.sign);
  if (next) setSigning(next);
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
          onDone={(reply) => {
            setSigning(null);
            if (reply) answered(signing.path, signing.n, signing.sign!, true)(reply);
            else setShown((now) => now.filter((each) => each.path !== signing.path || each.n !== signing.n));
          }}
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
