// Images a reply names by their path on the Mac (msgs/remote-wire.md, `attach <id> view`): one in the session's
// checkout comes as asked; any other only as its own resolved path, shown whole and signed with Face ID (power
// `paths`, D57). The Mac's copy then comes through `attachment`, drawn under the reply. The Face ID sheet is the
// composer's (`ImageSigns`), and what each tap came to is kept apart from the reply, so a reply folded away or scrolled
// off mid-signature loses neither.
import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Confirm } from "../act/Confirm";
import { forMac } from "../compose/state";
import { macNow } from "../link";
import { lists, thread } from "../mac/mac";
import { forgetImage, ThreadImage } from "../thread/Image";
import { ViewImage } from "../thread/Markdown";
import { color, text } from "../theme";
import { refusal } from "./powers";
import type { Frame } from "../../vendor/brigadier-shared/client";
import { store } from "../../vendor/brigadier-shared/store";

/** Paths waiting to be signed, oldest first, each with the Mac and session it was asked in; the first is the sheet's till it settles. */
const signs = store<readonly { key: number; mac: string; owner: string; sign: string; done: (reply: Frame | null) => void }[]>([]);
// Every ask's and sheet's number, unique in the app.
let asks = 0;

export const VIEW_WORDS = { title: "Show this image?", body: "It's outside this session's project, so this iPhone reads it only with Face ID." };

/** The Face ID sheet for the first path waiting, mounted once beside the thread. */
export function ImageSigns() {
  const first = useSyncExternalStore(signs.subscribe, () => signs.get()[0]);
  // Read again as the connection changes: one asked on another Mac is dropped, never signed on this one.
  useSyncExternalStore(lists.subscribe, () => lists.get().ready);
  const mac = macNow();
  useEffect(() => {
    const other = signs.get().filter((each) => each.mac !== mac);
    if (other.length === 0) return;
    signs.set(signs.get().filter((each) => each.mac === mac));
    other.forEach((each) => each.done(null));
  });
  if (!first || first.mac !== mac) return null;
  return (
    <Confirm
      key={first.key}
      {...VIEW_WORDS}
      shown={first.sign}
      args={["attach", first.owner, "view", first.sign]}
      onDone={(reply) => {
        signs.set(signs.get().filter((each) => each !== first));
        first.done(reply);
      }}
    />
  );
}

/** A path asked (`n`, its newest ask): being read, to sign, shown (the Mac's copy's id), or refused in the Mac's words. */
type Viewed = { path: string; n: number; sign?: string; id?: string; error?: string };
const NONE: readonly Viewed[] = [];
/** Each reply's taps, by Mac, session and reply. */
const viewed = store<ReadonlyMap<string, readonly Viewed[]>>(new Map());

/** The reply's text with its images' paths to tap, and each one tapped under it; `keep`, the reply's id. */
export function ReplyImages({ keep, children }: { keep: string; children: ReactNode }) {
  const { run } = forMac();
  const owner = useSyncExternalStore(thread.subscribe, () => thread.get()?.id);
  const at = `${macNow()}\n${owner}\n${keep}`;
  const shown = useSyncExternalStore(viewed.subscribe, () => viewed.get().get(at) ?? NONE);
  const setShown = (change: (now: readonly Viewed[]) => readonly Viewed[]) => viewed.set(new Map(viewed.get()).set(at, change(viewed.get().get(at) ?? NONE)));
  // An older ask's answer is dropped: only a path's newest counts.
  const set = (path: string, n: number, next: Omit<Viewed, "path" | "n">) => setShown((now) => now.map((each) => (each.path === path && each.n === n ? { path, n, ...next } : each)));
  /** The Mac's answer to `attach … view`: a path to sign comes back once; never one it turned down by its words. */
  const answered = (path: string, n: number, sent: string, signed: boolean) => (reply: Record<string, any>) => {
    if (!(viewed.get().get(at) ?? NONE).some((each) => each.path === path && each.n === n)) return;
    if (reply.ok) {
      forgetImage(owner!, reply.id);
      return set(path, n, { id: reply.id });
    }
    // To sign: the path the Mac resolved it to, or an absolute path already in that form.
    const sign = reply.error === "not_canonical" && typeof reply.path === "string" ? reply.path : !signed && reply.error === "Needs Face ID" && sent.startsWith("/") ? sent : null;
    if (sign === null) return set(path, n, { error: refusal(reply) });
    set(path, n, { sign });
    const done = (signedReply: Frame | null) =>
      signedReply ? answered(path, n, sign, true)(signedReply) : setShown((now) => now.filter((each) => each.path !== path || each.n !== n));
    signs.set([...signs.get(), { key: ++asks, mac: macNow(), owner: owner!, sign, done }]);
  };
  const view = (path: string) => {
    if (!owner) return;
    const n = ++asks;
    setShown((now) => [...now.filter((each) => each.path !== path), { path, n }]);
    void run(["attach", owner, "view", path]).then(answered(path, n, path, false));
  };
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
    </ViewImage.Provider>
  );
}

const st = StyleSheet.create({
  viewed: { gap: 4 },
  image: { width: "100%", aspectRatio: 4 / 3, borderRadius: 10 },
  name: { fontSize: 12, color: color.mutedForeground },
  error: { ...text.sm, color: color.destructive },
});
