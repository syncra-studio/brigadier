import type { Draft } from "./draft";

type Parts = Draft["parts"];

/** Command mode [D316]: words only that start with `!` are a shell command; a field in it shows them without the `!`, which is the mode. */
export const isShell = (parts: Parts): boolean => typeof parts[0] === "string" && parts[0].startsWith("!") && parts.every((part) => typeof part === "string");

/** A command's parts as its field shows them, and back. */
export const bare = (parts: Parts): Parts => [(parts as string[]).join("").slice(1)].filter(Boolean);
export const asShell = (parts: Parts): Parts => (typeof parts[0] === "string" ? [`!${parts[0]}`, ...parts.slice(1)] : ["!", ...parts]);
/** A message's words, its `!` first its own: an empty part before it keeps it from being the mode. */
export const asWords = (parts: Parts): Parts => (isShell(parts) ? ["", ...parts] : parts);

/** A `!` line's command, trimmed: "" with nothing to run, null for a message. */
export const shellLine = (parts: Parts): string | null => (isShell(parts) ? bare(parts).join("").trim() : null);
/** The command `parts` hold, trimmed; null for a message, or with nothing to run. */
export const commandOf = (parts: Parts): string | null => shellLine(parts) || null;
/** A message escaped from being a command: the empty part `asWords` puts first, kept while it's edited. */
export const isEscaped = (parts: Parts): boolean => parts.length > 1 && parts[0] === "";
