import { ask } from "../daemon";
import type { Draft } from "../components/composer/draft";
import { newId } from "./store";

/** A `!` line, words only (no chip, file or image), is a command for the session's folder, not a message [D316]. */
export function bangOf(parts: Draft["parts"]): string | null {
  const text = parts.every((part) => typeof part === "string") ? parts.join("").trim() : "";
  return text.startsWith("!") && text.slice(1).trim() ? text.slice(1).trim() : null;
}

/** Runs it at once, even while the agent works; its Shell row comes from Rust. Refused, `back` puts it back with why. */
export function runBang(session: string, line: string, back: (reply: Record<string, any>) => void): void {
  ask({ op: "run", args: ["shell", session, "run", `c-${newId()}`, line] }, (reply) => void (reply.ok || back(reply)));
}

/** The `!` commands running in view, oldest first: Ctrl+C in an empty composer stops the newest only [D320]. */
export const running: string[] = [];

/** Whether a key in an empty composer stops a running `!` command [D320]. */
export function isStopKey(event: KeyboardEvent): boolean {
  const field = (event.target as Element | null)?.closest?.('[aria-label="Message input"]');
  // Not ⌘.: the composer's model picker has it.
  return event.ctrlKey && !event.metaKey && event.key === "c" && Boolean(field) && !field!.textContent?.trim();
}
