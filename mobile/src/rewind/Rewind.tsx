// The rewind dialog, as the desktop's session/rewind.tsx and components/thread/rewind.tsx (RewindForm on ConfirmForm)
// [D384, D481]: Rust's preview first, then the chat back to just before the message, its files kept or the agent's changes undone, and the
// message back in the composer; after an undo, Redo file changes puts them back.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Draft } from "../../../app/shared/draft";
import { REWIND_CANT } from "../../../app/shared/words";
import { previewOf, redoneWords, REWIND_WORDS as W, type RewindPreview, rewoundWords, staysWords, why } from "../../../app/shared/session/rewind";
import { DialogButton } from "../Button";
import { forMac, newId } from "../compose/state";
import { store } from "../../../app/shared/store";
import { macNow } from "../link";
import { lists, thread } from "../mac/mac";
import { color, radius, space, spacing, touch } from "../theme";
import { ErrorLine } from "../thread/rows/parts";
import { Sheet, st } from "../sheets/Sheet";

/**
 * A rewind whose answer was lost, kept per Mac outside the dialog, so the menu offers Try again under its id after a
 * reconnect, its message gone from the thread or not.
 */
export type Lost = { mac: string; id: string; cid: string; op: string; restore: boolean; text: string; draft?: Draft | null };
export const lostRewinds = store<readonly Lost[]>([]);
const keepLost = (op: string, each: Lost | null) => lostRewinds.set([...lostRewinds.get().filter((one) => one.op !== op), ...(each ? [each] : [])]);

export function Rewind({ id, cid, text, draft, lost: was, onClose }: { id: string; cid: string; text: string; draft?: Draft | null; lost?: Lost; onClose: () => void }) {
  const { run, drafts } = forMac();
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restore, setRestore] = useState(false);
  const [busy, setBusy] = useState(false);
  // One id for all of this dialog's tries: a reply lost after the rewind landed is answered as already done.
  const [op] = useState(() => was?.op ?? newId());
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
  // The choice of a try whose answer was lost: Try again sends it under the same id, preview or none, as Rust answers
  // a rewind already done as done.
  const [lost, setLost] = useState<boolean | null>(was?.restore ?? null);
  const go = (restore: boolean) => {
    if (going.current || (!preview && lost === null)) return;
    going.current = true;
    setBusy(true);
    setError(null);
    // The Mac it goes to, kept under that one whatever is connected when its answer comes.
    const mac = macNow();
    void run(["rewind", id, cid, "--op", op, ...(restore ? ["--restore"] : [])]).then((reply) => {
      setBusy(false);
      if (!reply.ok) {
        going.current = false;
        // A try after a lost one stays unknown when refused ("queued" comes before Rust looks for it done): only an
        // answer that it went settles it.
        const unknown = lost !== null || reply.error === "closed" || reply.error === "disconnected";
        setLost(unknown ? restore : null);
        keepLost(op, unknown ? { mac, id, cid, op, restore, text, draft } : null);
        if (!unknown) setTries((n) => n + 1);
        return setError(why(reply));
      }
      // The message back in the composer, above what's typed there, its files with it; a `!` command's report as the
      // command. Under the dialog's one id, so it comes back once.
      keepLost(op, null);
      drafts.takeBack(run, id, { cid: op, parts: draft?.shell ? [`!${draft.shell}`] : (draft?.parts ?? [text]), attachmentIds: draft?.shell ? [] : (draft?.attachmentIds ?? []) });
      // An undo done already (its first answer lost) says no count: Redo stays offered for it.
      setDone({ words: rewoundWords(reply, restore), redo: restore && (reply.restored > 0 || reply.already === true) });
    });
  };
  // Rewound: what came of it stays here, with Redo file changes after an undo (the desktop's toast).
  const [done, setDone] = useState<{ words: string; redo: boolean } | null>(null);
  if (done) {
    // Redo file changes, one deep [D1196, D1246]: what came back, and what stayed as edited since.
    const redo = () => {
      setDone({ words: W.puttingBack, redo: false });
      void run(["rewind", id, cid, "--op", op, "--undo"]).then((reply) => setDone({ words: redoneWords(reply), redo: false }));
    };
    return <Sheet title={done.words} onClose={onClose} footer={done.redo ? <DialogButton title={W.redo} variant="ghost" onPress={redo} /> : undefined} />;
  }
  const { paths = [], hand = [], leftOut = [], nested = [], stale = [] } = preview ?? {};
  const chosen = lost ?? restore;
  const big = leftOut.filter((path) => !nested.includes(path));
  const can = paths.length > 0;
  const cant = preview?.why === undefined ? undefined : REWIND_CANT[preview.why];
  const sharer = preview?.sharer && lists.get().rows.find((row) => row.id === preview.sharer!.id)?.title;
  const stays = staysWords({ hand, big, nested, stale }).map((line) => <Note key={line}>{line}</Note>);
  return (
    <Sheet
      title={W.title}
      description={`${W.back}\n${W.returns}`}
      onClose={onClose}
      footer={
        <>
          <DialogButton title="Cancel" variant="ghost" disabled={busy} onPress={onClose} />
          {lost !== null ? <DialogButton title="Try again" busy={busy} onPress={() => go(lost)} /> : <DialogButton title={W.confirm} busy={busy || (!preview && !error)} disabled={!preview || preview.error !== undefined} onPress={() => go(restore)} />}
        </>
      }
    >
      {/* A try whose answer was lost shows its choice, fixed: Try again sends just that. */}
      {lost !== null && !can && <Note>{lost ? W.restore : W.keep}, as chosen before.</Note>}
      {can && (
        <View accessibilityRole="radiogroup" style={{ gap: space(3) }}>
          <Choice on={!chosen} label={W.keep} onPress={() => lost === null && setRestore(false)}>
            <Note>{W.keepNote}</Note>
          </Choice>
          <Choice on={chosen} label={W.restore} onPress={() => lost === null && setRestore(true)}>
            <Note>{W.undoes(paths)}</Note>
            <Note>{W.yours}</Note>
            {stays}
            <Note>{W.ignored}</Note>
            {preview?.commits && <Note>{W.commits}</Note>}
          </Choice>
        </View>
      )}
      {preview && !can && !preview.sharer && preview.error === undefined && (cant || (preview.why === undefined && hand.length + leftOut.length + stale.length > 0)) && (
        <View style={{ gap: space(0.5) }}>
          {cant ? <Note>{cant}</Note> : <><Note>{W.nothingBack}</Note>{stays}</>}
        </View>
      )}
      {preview?.sharer && <Note>{W.sharer(sharer || undefined, preview.sharer.now)}</Note>}
      <ErrorLine error={preview?.error ?? error} xs />
    </Sheet>
  );
}

const Note = ({ children }: { children: React.ReactNode }) => <Text style={st.note}>{children}</Text>;

/** A choice, the desktop's Radio before its label and notes: a ring that fills with the switch's blue round a dot. */
function Choice({ on, label, onPress, children }: { on: boolean; label: string; onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={onPress} style={styles.choice}>
      <View style={[styles.radio, on && styles.checked]}>{on ? <View style={styles.dot} /> : null}</View>
      <View style={{ flex: 1, gap: space(0.5) }}>
        <Text style={st.body}>{label}</Text>
        {children}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  choice: { flexDirection: "row", gap: space(2), minHeight: touch },
  // mt-0.5 against the label's first line.
  radio: { width: spacing.iconMd, height: spacing.iconMd, marginTop: space(0.5), borderRadius: radius.capsule, borderWidth: 1, borderColor: color.input, alignItems: "center", justifyContent: "center" },
  checked: { borderColor: color.toggleOn, backgroundColor: color.toggleOn },
  dot: { width: space(1.5), height: space(1.5), borderRadius: radius.capsule, backgroundColor: color.foreground },
});
