// An image the thread names, read from the Mac with `attachment` in 256 KiB pieces (msgs/remote-wire.md, M4): a
// session's sent and viewed images, and this phone's own unsent files. A grey square until it is in.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Image as Native, type ImageStyle, type StyleProp, View } from "react-native";
import { ask, macNow } from "../link";
import { lists, thread } from "../mac/mac";
import { color } from "../theme";

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

// shortcut: every image read this run stays in memory as a data URI; fine for a thread's few, upgrade to a file cache if threads hold many.
const read = new Map<string, Promise<string | null>>();

/** The image's bytes as a data URI, or null when the Mac hasn't it (or the stream ended: tried again next time). */
export function imageUri(owner: string, attachment: string, mime = "image/png"): Promise<string | null> {
  // Ids are each Mac's own: one Mac's image never stands in for another's.
  const key = `${macNow()}\n${owner}\n${attachment}`;
  const had = read.get(key);
  if (had) return had;
  const going = (async () => {
    const pieces: Uint8Array[] = [];
    let offset = 0;
    for (;;) {
      const reply = await ask({ op: "attachment", owner, attachment, offset });
      if (!reply.ok) return null;
      const piece = fromBase64(reply.data);
      pieces.push(piece);
      offset += piece.length;
      if (reply.done || piece.length === 0) break;
    }
    const all = new Uint8Array(offset);
    let at = 0;
    for (const piece of pieces) all.set(piece, (at += piece.length) - piece.length);
    return `data:${mime};base64,${toBase64(all)}`;
  })().catch(() => null);
  read.set(key, going);
  // A failed read isn't kept, so the next draw asks again.
  void going.then((uri) => uri === null && read.delete(key));
  return going;
}

/** An image of the open thread's session (or `owner`'s), drawn once its bytes are in. */
export function ThreadImage({ attachment, owner, mime, label, style }: { attachment: string; owner?: string | null; mime?: string; label: string; style: StyleProp<ImageStyle> }) {
  const open = useSyncExternalStore(thread.subscribe, () => thread.get()?.id);
  // Signed in again: a read that failed meanwhile is tried again.
  const ready = useSyncExternalStore(lists.subscribe, () => lists.get().ready);
  const from = owner ?? open;
  // The image drawn, by what it is: a lost stream keeps it; another image starts grey.
  const [got, setGot] = useState<{ key: string; uri: string | null }>({ key: "", uri: null });
  const key = `${macNow()}\n${from}\n${attachment}`;
  const uri = got.key === key ? got.uri : null;
  useEffect(() => {
    let live = true;
    if (from && ready && !uri) void imageUri(from, attachment, mime).then((read) => live && read && setGot({ key, uri: read }));
    return () => {
      live = false;
    };
  }, [key, mime, ready, uri]);
  if (!uri) return <View accessibilityRole="image" accessibilityLabel={label} style={[style as object, { backgroundColor: color.fill }]} />;
  return <Native accessibilityLabel={label} source={{ uri }} style={style} resizeMode="cover" />;
}
