// The rewind dialog, as the desktop's session/rewind.tsx and components/thread/rewind.tsx [D384, D481]: Rust's
// preview first, then the chat back to just before the message, its files kept or the agent's changes undone, and the
// message back in the composer; after an undo, Redo file changes puts them back.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { Draft } from "../../vendor/brigadier-shared/draft";
import { REWIND_CANT } from "../../vendor/brigadier-shared/words";
import { Button } from "../Button";
import { forMac, newId } from "../compose/state";
import { lists, thread } from "../mac/mac";
import { color } from "../theme";
import { Sheet, st } from "../sheets/Sheet";

type Preview = { paths: string[]; hand: string[]; leftOut: string[]; nested: string[]; stale: string[]; commits: boolean; sharer?: { id: string; now: boolean }; why?: string };

const why = (reply: Record<string, any>) => (reply.error === "disconnected" ? "Brigadier isn't running, so the outcome isn't known yet." : String(reply.message ?? reply.error ?? "Refused"));
const named = (paths: string[]) => (paths.length > 5 ? `${paths.slice(0, 5).join(", ")} and ${paths.length - 5} more` : paths.join(", "));
const files = (n: number) => (n === 1 ? "1 file" : `${n} files`);

function previewOf(reply: Record<string, any>): Preview {
  const none = { paths: [], hand: [], leftOut: [], nested: [], stale: [], commits: false };
  if (reply.restore === true) return { paths: reply.paths ?? [], hand: reply.hand ?? [], leftOut: reply.leftOut ?? [], nested: reply.nested ?? [], stale: reply.stale ?? [], commits: reply.commits === true };
  // Another session in the folder keeps the files [D1078]; else Rust's reason [D384].
  return typeof reply.with === "string" ? { ...none, sharer: { id: reply.with, now: reply.why === "busy" } } : { ...none, why: String(reply.why) };
}

function said(reply: Record<string, any>, restore: boolean): string {
  if (reply.already) return "Rewound · check your files";
  if (!restore) return "Rewound · your files are as they were";
  const count = `${reply.restored} ${reply.restored === 1 ? "file" : "files"} undone`;
  return reply.complete === false ? `Rewound · ${count}, some stayed as they are` : `Rewound · ${count}`;
}

export function Rewind({ id, cid, text, draft, onClose }: { id: string; cid: string; text: string; draft?: Draft | null; onClose: () => void }) {
  const { run, drafts } = forMac();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restore, setRestore] = useState(false);
  const [busy, setBusy] = useState(false);
  // One id for all of this dialog's tries: a reply lost after the rewind landed is answered as already done.
  const [op] = useState(newId);
  // A restore undoes every turn from here as they are when it runs: a turn starting or ending reads the preview again,
  // and a choice made on the old one is made again.
  const turns = useSyncExternalStore(thread.subscribe, () => {
    const session = thread.get()?.id === id ? thread.get()?.session : null;
    return (session?.turns ?? []).map((turn) => `${turn.id}:${turn.status}`).join(" ");
  });
  // One request at a time, taps before the spinner shows included; none once it's done.
  const going = useRef(false);
  // Moved on by a refused rewind: what it was shown may be stale, so it's read again before another try.
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (going.current) return;
    let live = true;
    setPreview(null);
    setRestore(false);
    void run(["rewind", id, cid, "--preview"]).then((reply) => live && (reply.ok ? setPreview(previewOf(reply)) : setError(why(reply))));
    return () => void (live = false);
  }, [turns, tries]);
  const go = () => {
    if (going.current || !preview) return;
    going.current = true;
    setBusy(true);
    setError(null);
    void run(["rewind", id, cid, "--op", op, ...(restore ? ["--restore"] : [])]).then((reply) => {
      setBusy(false);
      if (!reply.ok) {
        going.current = false;
        setTries((n) => n + 1);
        return setError(why(reply));
      }
      // The message back in the composer, above what's typed there, its files with it; a `!` command's report as the
      // command. Under the dialog's one id, so it comes back once.
      drafts.takeBack(run, id, { cid: op, parts: draft?.shell ? [`!${draft.shell}`] : (draft?.parts ?? [text]), attachmentIds: draft?.shell ? [] : (draft?.attachmentIds ?? []) });
      setDone({ words: said(reply, restore), redo: restore && reply.restored > 0 });
    });
  };
  // Rewound: what came of it stays here, with Redo file changes after an undo (the desktop's toast).
  const [done, setDone] = useState<{ words: string; redo: boolean } | null>(null);
  if (done) {
    return (
      <Sheet title={done.words} onClose={onClose}>
        {done.redo && <Button title="Redo file changes" secondary onPress={() => { setDone({ words: "Putting the agent's changes back…", redo: false }); undo(run, id, cid, op, (words) => setDone({ words, redo: false })); }} />}
      </Sheet>
    );
  }
  const { paths = [], hand = [], leftOut = [], nested = [], stale = [] } = preview ?? {};
  const big = leftOut.filter((path) => !nested.includes(path));
  const can = paths.length > 0;
  const cant = preview?.why === undefined ? undefined : REWIND_CANT[preview.why];
  const sharer = preview?.sharer && (lists.get().rows.find((row) => row.id === preview.sharer!.id)?.title || "another session");
  const stays = (
    <>
      {hand.length > 0 && <Text style={st.muted}>Left as you edited them: {named(hand)}.</Text>}
      {big.length > 0 && <Text style={st.muted}>Too big to go back: {named(big)}.</Text>}
      {nested.length > 0 && <Text style={st.muted}>Nested repositories stay as they are: {named(nested)}.</Text>}
      {stale.length > 0 && <Text style={st.muted}>No snapshot was taken of these repos for every turn, so they stay as they are: {named(stale)}.</Text>}
    </>
  );
  return (
    <Sheet title="Rewind to this message?" onClose={onClose}>
      <Text style={st.body}>The chat goes back to just before this message. Your message returns to the composer.</Text>
      {!preview && !error && <ActivityIndicator color={color.mutedForeground} />}
      {can && (
        <>
          <Choice on={!restore} label="Keep files as they are" onPress={() => setRestore(false)}>
            <Text style={st.muted}>Only the chat goes back.</Text>
          </Choice>
          <Choice on={restore} label="Undo the agent's file changes" onPress={() => setRestore(true)}>
            <Text style={st.muted}>Undoes {files(paths.length)} changed during these turns: {named(paths)}.</Text>
            <Text style={st.muted}>Edits you made while the agent worked are included, and Redo brings them back.</Text>
            {stays}
            <Text style={st.muted}>Ignored files (like .env) aren't in snapshots and stay as they are.</Text>
            {preview?.commits && <Text style={st.muted}>Commits made since then stay.</Text>}
          </Choice>
        </>
      )}
      {preview && !can && !preview.sharer && (cant ? <Text style={st.muted}>{cant}</Text> : preview.why === undefined && hand.length + leftOut.length + stale.length > 0 ? <><Text style={st.muted}>Files stay: nothing the agent changed can go back.</Text>{stays}</> : null)}
      {sharer && <Text style={st.muted}>Files stay: {sharer} {preview?.sharer?.now ? "is working in this folder now" : "was working in this folder during this turn"}.</Text>}
      {error && <Text style={st.error}>{error}</Text>}
      {busy ? <ActivityIndicator color={color.foreground} /> : <Button title="Rewind" disabled={!preview} onPress={go} />}
    </Sheet>
  );
}

function Choice({ on, label, onPress, children }: { on: boolean; label: string; onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={onPress} style={[st.item, { alignItems: "flex-start" }, on && st.on]}>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={st.body}>{label}</Text>
        {children}
      </View>
    </Pressable>
  );
}

/** Redo file changes, one deep [D1196, D1246]: what came back, and what stayed as edited since. */
function undo(run: ReturnType<typeof forMac>["run"], id: string, cid: string, op: string, tell: (words: string) => void) {
  void run(["rewind", id, cid, "--op", op, "--undo"]).then((reply) => {
    if (!reply.ok) return tell(`Couldn't put the agent's changes back: ${why(reply)}`);
    const kept: string[] = reply.kept ?? [];
    const back = `The agent's changes are back · ${files(reply.undone)}`;
    tell(kept.length > 0 ? `${back}, kept as edited since: ${named(kept)}` : back);
  });
}
