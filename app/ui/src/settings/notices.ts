import { useEffect } from "react";

import { type Row, useDaemon } from "../daemon";
import { getSettings, setSetting } from "./api";

/*
 * macOS notices and the Dock badge, mounted for the app's lifetime [D200, D2004, D2012]. Rust says what is worth a
 * notice: each row's `notice`, one id per occasion. The page only delivers it, by the user's settings, and skips
 * the session on screen while the window has focus. Ids already there when the app opens, or seen before a
 * reconnect, are never sent again.
 */

type Notice = { id: string; kind: "question" | "approval" | "sign_in" | "done" | "failed"; text: string | null };

const seen = new Set<string>();
let started = false;

const titleOf = (row: Row) => row.title || "Untitled";

// The words are the UI's; Rust sends what happened [D64].
function words(row: Row, notice: Notice): { title: string; body: string } {
  switch (notice.kind) {
    case "question":
      return { title: "A question for you", body: notice.text || titleOf(row) };
    case "approval":
      return { title: "Awaiting approval", body: titleOf(row) };
    case "sign_in":
      return { title: "Sign-in needed", body: notice.text || titleOf(row) };
    case "done":
      return { title: titleOf(row), body: "Done" };
    case "failed":
      return { title: titleOf(row), body: notice.text ? `Stopped with an error: ${notice.text}` : "Stopped with an error" };
  }
}

/** Sends one notice and keeps what macOS did with it, which is all Electron can tell of its permission [D2024]. */
export async function sendNotice(notice: { title: string; body: string; session?: string }): Promise<void> {
  const settings = getSettings();
  const result = await window.brigadier?.notify({ ...notice, silent: settings ? !settings.sound : false });
  const now = result === "blocked" ? "blocked" : result === "shown" ? "sent" : null;
  if (now && settings?.notices !== now) await setSetting("notices", now);
}

function deliver(row: Row, notice: Notice, open: string | null): void {
  const settings = getSettings();
  if (!settings || row.archived) return;
  const focused = document.hasFocus();
  if (focused && row.id === open) return;
  const needs = notice.kind !== "done" && notice.kind !== "failed";
  const wanted = needs ? settings.notify_needs_you : settings.notify_finished === "always" || (settings.notify_finished === "background" && !focused);
  if (wanted) void sendNotice({ ...words(row, notice), session: row.id }).catch((error: unknown) => console.error(error));
}

/** Delivers Rust's notices, keeps the Dock's badge at the count of sessions that need you and the menu bar's Running list. */
export function useNotices(open: string | null): void {
  const rows = useDaemon().rows?.filter((row) => !row.noteChat);
  useEffect(() => {
    if (!rows) return;
    for (const row of rows) {
      const notice = (row as Row & { notice?: Notice | null }).notice;
      if (!notice) continue;
      const key = `${row.id} ${notice.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // What was already there when the app opened was told before, or happened while it was shut.
      if (started) deliver(row, notice, open);
    }
    started = true;
  }, [rows, open]);
  const count = rows?.filter((row) => !row.archived && (row.mark === "needs" || row.mark === "amber")).length ?? 0;
  useEffect(() => window.brigadier?.badge(count), [count]);
  // The menu bar item's Running list, as the old app's: sessions an agent works in now, not workers or archived ones.
  const running = JSON.stringify(rows?.filter((row) => row.works && !row.archived && (!row.worker || row.boss)).map((row) => ({ id: row.id, title: titleOf(row) })) ?? []);
  useEffect(() => window.brigadier?.running(JSON.parse(running)), [running]);
  // A click on a notice opens its session.
  useEffect(() => window.brigadier?.onNoticeClick((id) => (window.location.hash = `#thread/${encodeURIComponent(id)}`)), []);
}
