// The open thread's sheets, one at a time: from the header's ⋯ (changes, background, plan, fork from the latest answer,
// rewind to a message) or a `!` command's row (its output). A held message selects its text, so nothing hangs on that.
import { useSyncExternalStore } from "react";
import { ActionSheetIOS, Alert, Pressable, Text } from "react-native";
import type { Draft } from "../../vendor/brigadier-shared/draft";
import { store } from "../../vendor/brigadier-shared/store";
import { Fork } from "../fork/Fork";
import { thread } from "../mac/mac";
import { Rewind } from "../rewind/Rewind";
import { color, text } from "../theme";
import { Background } from "./Background";
import { Changes } from "./Changes";
import { Plan } from "./Plan";
import { ShellOutput } from "./Shell";

type Open =
  | { kind: "changes" | "background" | "plan" }
  | { kind: "shell"; cmd: string; command: string }
  | { kind: "rewind"; cid: string; text: string; draft?: Draft | null }
  | { kind: "fork"; at: string };
/** The sheet open over session `id`'s thread. */
export const sheet = store<(Open & { id: string }) | null>(null);

const choose = (actions: [string, () => void][], title?: string) =>
  ActionSheetIOS.showActionSheetWithOptions({ title, options: [...actions.map(([each]) => each), "Cancel"], cancelButtonIndex: actions.length }, (at) => actions[at]?.[1]());

/** The thread header's ⋯. */
export function SessionMenu({ id }: { id: string }) {
  const open = (each: Open) => sheet.set({ ...each, id });
  const session = () => (thread.get()?.id === id ? thread.get()?.session : null);
  const fork = () => {
    // The latest answer's turn, read here so the check needs no Face ID.
    // shortcut: a wake that carried that turn on forks from the turn's start, not the wake (the thread names no wake's
    // boundary, and `fork --latest` needs a signature); use `--latest`'s `at` once the Mac takes it unsigned.
    const answer = (session()?.items ?? []).filter((item) => item.kind === "message" && item.role === "assistant" && item.final).pop();
    answer ? open({ kind: "fork", at: answer.turnId }) : Alert.alert("No answer to fork from yet.");
  };
  // The user's messages Rust says a rewind can go back to, newest first.
  const rewind = () => {
    const can = new Set(session()?.rewind ?? []);
    const messages = (session()?.items ?? []).flatMap((item) => (item.kind === "message" && item.role === "user" && item.cid && can.has(item.cid) ? [{ ...item, cid: item.cid }] : [])).reverse().slice(0, 8);
    if (messages.length === 0) return Alert.alert("No message to rewind to yet.");
    choose(messages.map((item) => [(item.draft?.shell ? `!${item.draft.shell}` : item.text).replace(/\s+/g, " ").slice(0, 60) || "Message", () => open({ kind: "rewind", cid: item.cid, text: item.text, draft: item.draft })]), "Rewind to this message");
  };
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="More" hitSlop={12} onPress={() => choose([["Changes", () => open({ kind: "changes" })], ["Background", () => open({ kind: "background" })], ["Plan", () => open({ kind: "plan" })], ["Fork", fork], ["Rewind", rewind]])}>
      <Text style={{ ...text.lg, color: color.foreground }}>⋯</Text>
    </Pressable>
  );
}

/** Session `id`'s sheet, under its thread; `onOpen` opens another session in its place (a fork). */
export function Sheets({ id, onOpen }: { id: string; onOpen: (id: string, title: string) => void }) {
  const open = useSyncExternalStore(sheet.subscribe, sheet.get);
  if (open?.id !== id) return null;
  const close = () => sheet.set(null);
  switch (open.kind) {
    case "changes":
      return <Changes id={id} onClose={close} />;
    case "background":
      return <Background id={id} onClose={close} />;
    case "plan":
      return <Plan id={id} onClose={close} />;
    case "shell":
      return <ShellOutput key={open.cmd} id={id} cmd={open.cmd} command={open.command} onClose={close} />;
    case "rewind":
      return <Rewind key={open.cid} id={id} cid={open.cid} text={open.text} draft={open.draft} onClose={close} />;
    case "fork":
      return <Fork key={open.at} id={id} at={open.at} onForked={onOpen} onClose={close} />;
  }
}
