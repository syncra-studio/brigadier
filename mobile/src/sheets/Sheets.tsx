// The open thread's sheets, one at a time: from the header's ⋯ (changes, background, plan, fork from the latest answer,
// rewind to a message) or a `!` command's row (its output). A held message selects its text, so nothing hangs on that.
import { useSyncExternalStore } from "react";
import { ActionSheetIOS, Alert, Pressable, Text } from "react-native";
import type { Draft } from "../../../app/shared/draft";
import { store } from "../../../app/shared/store";
import { DotsHorizontal } from "../../../app/ui/src/icons";
import { Fork } from "../fork/Fork";
import { thread } from "../mac/mac";
import { macNow } from "../link";
import { type Lost, lostRewinds, Rewind } from "../rewind/Rewind";
import { color, text } from "../theme";
import { Background } from "./Background";
import { Changes, type File } from "./Changes";
import { Plan } from "./Plan";
import { ShellOutput } from "./Shell";

type Open =
  | { kind: "changes"; file?: File }
  | { kind: "background" | "plan" }
  | { kind: "shell"; cmd: string; command: string }
  | { kind: "rewind"; cid: string; text: string; draft?: Draft | null; lost?: Lost }
  | { kind: "fork" };
/** The sheet open over session `id`'s thread. */
export const sheet = store<(Open & { id: string }) | null>(null);

const choose = (actions: [string, () => void][], title?: string) =>
  ActionSheetIOS.showActionSheetWithOptions({ title, options: [...actions.map(([each]) => each), "Cancel"], cancelButtonIndex: actions.length }, (at) => actions[at]?.[1]());

/** The thread header's ⋯. */
export function SessionMenu({ id }: { id: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="More" hitSlop={12} onPress={() => sessionMenu(id)}>
      <DotsHorizontal className="size-icon-md text-foreground" />
    </Pressable>
  );
}

/** Its menu: the sheets, Fork and Rewind. */
export function sessionMenu(id: string) {
  const open = (each: Open) => sheet.set({ ...each, id });
  const session = () => (thread.get()?.id === id ? thread.get()?.session : null);
  // The user's messages Rust says a rewind can go back to, newest first.
  const rewind = () => {
    const can = new Set(session()?.rewind ?? []);
    const messages = (session()?.items ?? []).flatMap((item) => (item.kind === "message" && item.role === "user" && item.cid && can.has(item.cid) ? [{ ...item, cid: item.cid }] : [])).reverse().slice(0, 8);
    const label = (text: string, draft?: Draft | null) => (draft?.shell ? `!${draft.shell}` : text).replace(/\s+/g, " ").slice(0, 60) || "Message";
    // A rewind whose answer was lost first: its message may be gone already.
    const lost = lostRewinds.get().filter((each) => each.mac === macNow() && each.id === id);
    if (messages.length + lost.length === 0) return Alert.alert("No message to rewind to yet.");
    choose(
      [
        ...lost.map((each): [string, () => void] => [`Try again: ${label(each.text, each.draft)}`, () => open({ kind: "rewind", cid: each.cid, text: each.text, draft: each.draft, lost: each })]),
        ...messages.map((item): [string, () => void] => [label(item.text, item.draft), () => open({ kind: "rewind", cid: item.cid, text: item.text, draft: item.draft })]),
      ],
      "Rewind to this message",
    );
  };
  choose([["Changes", () => open({ kind: "changes" })], ["Background", () => open({ kind: "background" })], ["Plan", () => open({ kind: "plan" })], ["Fork", () => open({ kind: "fork" })], ["Rewind", rewind]]);
}

/** Session `id`'s sheet, under its thread; `onOpen` opens another session in its place (a fork). */
export function Sheets({ id, onOpen }: { id: string; onOpen: (id: string, title: string) => void }) {
  const open = useSyncExternalStore(sheet.subscribe, sheet.get);
  if (open?.id !== id) return null;
  const close = () => sheet.set(null);
  switch (open.kind) {
    case "changes":
      return <Changes id={id} file={open.file} onClose={close} />;
    case "background":
      return <Background id={id} onClose={close} />;
    case "plan":
      return <Plan id={id} onClose={close} />;
    case "shell":
      return <ShellOutput key={open.cmd} id={id} cmd={open.cmd} command={open.command} onClose={close} />;
    case "rewind":
      return <Rewind key={open.lost?.op ?? open.cid} id={id} cid={open.cid} text={open.text} draft={open.draft} lost={open.lost} onClose={close} />;
    case "fork":
      return <Fork id={id} onForked={onOpen} onClose={close} />;
  }
}
