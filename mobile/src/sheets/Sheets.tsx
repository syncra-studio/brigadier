// The open thread's sheets, one at a time: from the header's ⋯ (changes, background, plan, fork from the latest answer,
// rewind to a message) or a `!` command's row (its output). A held message selects its text, so nothing hangs on that.
import { useState, useSyncExternalStore } from "react";
import type { Draft } from "../../../app/shared/draft";
import { store } from "../../../app/shared/store";
import { BranchAlt, Compare, EditPencil, Tasks } from "../../../app/ui/src/icons";
import { Clock } from "../../../app/ui/src/landing/icons";
import { Fork } from "../fork/Fork";
import { thread } from "../mac/mac";
import { macNow } from "../link";
import { type Lost, lostRewinds, Rewind } from "../rewind/Rewind";
import { Background } from "./Background";
import { Changes, type File } from "./Changes";
import { Plan } from "./Plan";
import { MenuItem, MenuLabel, MenuSeparator, MenuSheet } from "./Sheet";
import { ShellOutput } from "./Shell";

type Open =
  | { kind: "changes"; file?: File }
  | { kind: "background" | "plan" }
  | { kind: "shell"; cmd: string; command: string }
  | { kind: "rewind"; cid: string; text: string; draft?: Draft | null; lost?: Lost }
  | { kind: "fork" }
  | { kind: "menu" | "rewinds" };
/** The sheet open over session `id`'s thread. */
export const sheet = store<(Open & { id: string }) | null>(null);

/** The thread header's ⋯ menu: the sheets, Fork and Rewind. */
export function sessionMenu(id: string) {
  sheet.set({ kind: "menu", id });
}

const ICON = "size-icon-md text-muted-foreground";

/**
 * The ⋯ menu as the desktop's DropdownMenu, from the bottom; Rewind lists the user's messages Rust says a rewind can go
 * back to, newest first. A pick opens its sheet once the menu has gone: iOS shows one at a time.
 */
function SessionMenu({ id, rewinds }: { id: string; rewinds: boolean }) {
  const [next, setNext] = useState<Open | null | undefined>(undefined);
  const go = (each: Open | null) => setNext(each);
  const session = thread.get()?.id === id ? thread.get()?.session : null;
  const can = new Set(session?.rewind ?? []);
  const messages = (session?.items ?? []).flatMap((item) => (item.kind === "message" && item.role === "user" && item.cid && can.has(item.cid) ? [{ ...item, cid: item.cid }] : [])).reverse().slice(0, 8);
  const label = (text: string, draft?: Draft | null) => (draft?.shell ? `!${draft.shell}` : text).replace(/\s+/g, " ").slice(0, 60) || "Message";
  // A rewind whose answer was lost first: its message may be gone already.
  const lost = lostRewinds.get().filter((each) => each.mac === macNow() && each.id === id);
  return (
    <MenuSheet visible={next === undefined} onClose={() => go(null)} onDismiss={() => sheet.set(next ? { ...next, id } : null)}>
      {rewinds ? (
        <>
          <MenuLabel>Rewind to this message</MenuLabel>
          {messages.length + lost.length === 0 ? <MenuLabel>No message to rewind to yet.</MenuLabel> : null}
          {lost.map((each) => <MenuItem key={each.op} icon={<EditPencil className={ICON} />} title={`Try again: ${label(each.text, each.draft)}`} onPress={() => go({ kind: "rewind", cid: each.cid, text: each.text, draft: each.draft, lost: each })} />)}
          {messages.map((item) => <MenuItem key={item.cid} icon={<EditPencil className={ICON} />} title={label(item.text, item.draft)} onPress={() => go({ kind: "rewind", cid: item.cid, text: item.text, draft: item.draft })} />)}
        </>
      ) : (
        <>
          <MenuItem icon={<Compare className={ICON} />} title="Changes" onPress={() => go({ kind: "changes" })} />
          <MenuItem icon={<Clock className={ICON} />} title="Background" onPress={() => go({ kind: "background" })} />
          <MenuItem icon={<Tasks className={ICON} />} title="Plan" onPress={() => go({ kind: "plan" })} />
          <MenuSeparator />
          <MenuItem icon={<BranchAlt className={ICON} />} title="Fork" onPress={() => go({ kind: "fork" })} />
          <MenuItem icon={<EditPencil className={ICON} />} title="Rewind" onPress={() => go({ kind: "rewinds" })} />
        </>
      )}
    </MenuSheet>
  );
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
    case "menu":
    case "rewinds":
      return <SessionMenu key={open.kind} id={id} rewinds={open.kind === "rewinds"} />;
  }
}
