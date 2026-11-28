// A session row's own actions, held in the list, as the desktop's row menu by projects words them (sidebar/menu.tsx,
// sessions/archive.tsx, sessions/archived.tsx), which pins no session there [D808]: Rename, Archive and Delete; an
// archived row's Restore and Delete. Delete removes a worktree, so it is signed with Face ID (remote/rows.rs).
import { ActionSheetIOS, Alert } from "react-native";
import type { Row } from "../../../app/shared/rows";
import { ARCHIVE_LOSES, archiveAsk, closed, deleteFailed, type Lost, lostText, sessionActions, unchecked, workingLine } from "../../../app/shared/session/actions";
import { failure } from "../../../app/shared/session/run";
import { store } from "../../../app/shared/store";
import { forMac } from "../compose/state";
import { macNow, onClosed } from "../link";

const byMac = new Map<string, ReturnType<typeof sessionActions>>();
/**
 * What acts for a row of Mac `mac` (the Mac its list came from): that Mac's runner and queue while it is the one
 * connected, else null. Every step goes through it, so nothing is sent, asked or signed for a row on another Mac; and
 * its runner refuses by itself once another Mac is connected (`forMac`).
 */
function onMac(mac: string) {
  if (!mac || macNow() !== mac) return null;
  const { run } = forMac();
  if (!byMac.has(mac)) byMac.set(mac, sessionActions(run, (words) => Alert.alert(words)));
  return { run, actions: byMac.get(mac)! };
}
/** The connected Mac's queue, for what the list shows while its actions go. */
export const actionsOf = () => onMac(macNow())?.actions ?? null;

/** Delete's confirm, over the list: the Mac its row came from, the row, and the workers Rust's check says it stops. */
export const deleting = store<{ mac: string; row: Row; running: number } | null>(null);
// Any Mac's stream ending (a switch, a sign-out) takes the confirm with it: it is never shown or signed for another.
onClosed(() => deleting.set(null));

/** A held row's menu; `mac`, the Mac its list came from. */
export function rowMenu(row: Row, mac: string) {
  type Choice = [string, () => void];
  const act = (f: (m: NonNullable<ReturnType<typeof onMac>>) => void) => () => {
    const m = onMac(mac);
    if (m) f(m);
  };
  const live: Choice[] = [
    ["Rename", act(() => rename(row, mac))],
    ["Archive", act(() => void archive(row, mac))],
  ];
  const choices: Choice[] = [
    ...(closed(row) ? [] : live),
    ...(row.archived ? [["Restore", act(({ actions }) => actions.restore(row))] as Choice] : []),
    ["Delete", act(() => void askDelete(row, mac))],
  ];
  const left = row.lifecycle?.left;
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: row.title || "New session",
      message: left ? `Couldn't delete everything: ${left[0]}` : undefined,
      options: [...choices.map(([each]) => each), "Cancel"],
      cancelButtonIndex: choices.length,
      destructiveButtonIndex: choices.length - 1,
    },
    (at) => choices[at]?.[1](),
  );
}

function rename(row: Row, mac: string) {
  Alert.prompt("Rename session", undefined, [{ text: "Cancel", style: "cancel" }, { text: "Rename", onPress: (value) => void renamed(row, mac, value ?? "") }], "plain-text", row.title);
}

/** Rust's preview names the branch a rename takes, pinned so a changed one refuses, as the desktop's form submits. */
async function renamed(row: Row, mac: string, value: string) {
  const title = value.trim();
  const m = onMac(mac);
  if (!m) return;
  if (!title) return Alert.alert("Title can't be empty.");
  if (title === row.title) return;
  const preview = await m.run(["rename", row.id, title, "--preview"]);
  if (!onMac(mac)) return;
  if (preview.error === "closed") return Alert.alert("Couldn't rename", failure(preview));
  if (!preview.ok) Alert.alert(failure(preview));
  m.actions.rename(row, title, preview.ok ? (preview.branch ?? "-") : undefined);
}

/** Rust's check first: with nothing to say it archives at once, else its confirm says it [D1197]. */
async function archive(row: Row, mac: string) {
  const m = onMac(mac);
  if (!m) return;
  const check = await m.run(["archive", row.id, "--check"]);
  if (!onMac(mac)) return;
  if (check.error === "closed") return Alert.alert(unchecked(failure(check)));
  const go = (named: string[]) => onMac(mac)?.actions.archive(row, named);
  const running: string[] = check.running ?? [];
  const lost: Lost[] = check.lost ?? [];
  if (check.ok && running.length + lost.length === 0) return go(check.named ?? []);
  const words = archiveAsk([row]);
  const lines = check.ok ? [...running.map(() => workingLine()), ...lost.map((each) => lostText(each, ARCHIVE_LOSES))] : [unchecked(failure(check))];
  Alert.alert(words.title, [words.description, ...lines].join("\n\n"), [
    { text: "Cancel", style: "cancel" },
    { text: words.confirm, style: lost.some((each) => each.files) ? "destructive" : "default", onPress: () => go(check.named ?? []) },
  ]);
}

/** Rust's check adds the workers delete stops; the confirm, shown and signed only while `mac` is connected, deletes. */
async function askDelete(row: Row, mac: string) {
  const m = onMac(mac);
  if (!m) return;
  const check = await m.run(["delete", row.id, "--check"]);
  // A check that came back after a switch asks nothing.
  if (!onMac(mac)) return;
  if (!check.ok) return Alert.alert(deleteFailed(row, check));
  const running = ((check.running ?? []) as string[]).filter((id) => id !== row.id).length;
  deleting.set({ mac, row, running });
}
