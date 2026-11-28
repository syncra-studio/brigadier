// The powers (D57, crates/daemon/src/remote/powers.rs): what the Face ID sheet shows for each, and the Mac's words when it refuses.
import type { Draft } from "../../../app/shared/draft";
import { failure } from "../../../app/shared/session/run";

/** A `<Confirm>` sheet's words and the exact command it signs. */
export type Power = { title: string; body?: string; shown: string; args: string[] };

/** The Mac's refusal in its own words ("Needs Face ID", "Turned off for this iPhone on your Mac", …). */
export const refusal = (reply: Record<string, any>) => (reply.error === "closed" && !reply.message ? "Not connected to your Mac" : failure(reply));

/** A `!` line's command, trimmed, as the desktop's shell.ts `commandOf`: "" with nothing to run, null for a message. */
export function shellOf(parts: Draft["parts"]): string | null {
  if (!parts.every((part) => typeof part === "string")) return null;
  const words = parts.join("");
  return words.startsWith("!") ? words.slice(1).trim() : null;
}

/** A `!` command through the session's queue: at once between turns, else in its turn; only ever with these flags. */
export const shellPower = (id: string, line: string, qid: string, slot?: number): Power => ({
  title: "Run this command on your Mac?",
  body: "It runs in this session's folder, exactly as shown.",
  shown: line,
  args: ["queue", id, "add", line, "--qid", qid, "--shell", ...(slot === undefined ? [] : ["--at", String(slot)])],
});

/** What waits in the queue goes on while the command keeps running. */
export const backgroundPower = (id: string, cmd: string, line: string): Power => ({
  title: "Run in background?",
  body: "What waits in the queue goes on while this keeps running.",
  shown: line || cmd,
  args: ["queue", id, "background", cmd],
});
