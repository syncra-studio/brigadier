// A session's own marks, for both apps [D30, D40, D58]: pin, label, rename, seen, archive and restore, shown at once
// and settled by Rust, and the words archive's and delete's confirms say [D35, D1197].
import type { Frame } from "../client";
import type { Row } from "../rows";
import { store } from "../store";
import { failure, type Runner } from "./run";

/** What a change touches on its row: the desktop's rows carry labels too. */
type Marked = Pick<Row, "id" | "title" | "pinned" | "archived" | "touched"> & { labels?: string[] };
type Change = { pinned?: number | null; title?: string; archived?: number | null; label?: { name: string; on: boolean } };
type Action = { args: string[]; change: Change; failed: string; sent?: boolean; at?: number };

/**
 * Each session's actions go one at a time, in order, so two never cross. One is sent by its request id; it holds its
 * change on the row until its reply is ok and Rust's row has caught up with it (`touched`, the session folder's time,
 * at least the time its reply gave). A refusal takes the change back and `tell`s why.
 */
export function sessionActions(run: Runner, tell: (words: string, error: boolean) => void) {
  const queues = store(new Map<string, Action[]>());
  let rows = new Map<string, Marked>();
  const emit = () => queues.set(new Map(queues.get()));

  function sendFirst(id: string): void {
    const action = queues.get().get(id)?.[0];
    if (!action || action.sent) return;
    action.sent = true;
    void run(action.args).then((reply) => {
      const queue = queues.get().get(id);
      if (queue?.[0] !== action) return;
      if (reply.ok) {
        action.at = reply.at ?? 0;
        // Done, with something the user should know (an archive whose workers' processes still run).
        if (reply.warning) tell(String(reply.warning), false);
        return settle(id);
      }
      queue.shift();
      if (action.failed) tell(`${action.failed}: ${failure(reply)}`, true);
      emit();
      sendFirst(id);
    });
  }

  // Drops the first action once Rust's row shows it, then sends the next.
  function settle(id: string): void {
    const action = queues.get().get(id)?.[0];
    if (action?.at === undefined || (rows.get(id)?.touched ?? 0) < action.at) return;
    queues.get().get(id)!.shift();
    emit();
    sendFirst(id);
  }

  function queue(id: string, args: string[], change: Change, failed: string): void {
    queues.get().set(id, [...(queues.get().get(id) ?? []), { args, change, failed }]);
    emit();
    sendFirst(id);
  }

  const named = (row: Marked) => `“${row.title || "New session"}”`;
  return {
    queues,
    pin: (row: Marked, on: boolean) => queue(row.id, on ? ["pin", row.id] : ["pin", row.id, "--off"], { pinned: on ? Date.now() : null }, on ? "Couldn't pin" : "Couldn't unpin"),
    /** Gives the session a label, or takes it off [D3101, D3103]. */
    label: (row: Marked, name: string, on: boolean) =>
      queue(row.id, ["label", row.id, name, ...(on ? [] : ["--off"])], { label: { name, on } }, on ? `Couldn't add the label “${name}”` : `Couldn't remove the label “${name}”`),
    /** `workers`: those whose losses archive's confirm named [D1197]. */
    archive: (row: Marked, workers: string[] = []) => queue(row.id, ["archive", row.id, `--named=${workers.join(",")}`], { archived: Date.now() }, `Couldn't archive ${named(row)}`),
    restore: (row: Marked) => queue(row.id, ["restore", row.id], { archived: null }, `Couldn't bring back ${named(row)}`),
    /** `branch`: the name Rust's preview gave, `-` for none, pinned so a changed preview refuses [D1217]. */
    rename: (row: Marked, title: string, branch?: string) => queue(row.id, ["rename", row.id, title, ...(branch === undefined ? [] : ["--branch", branch])], { title }, "Couldn't rename"),
    /** Read up to `finished`, behind any action still going; no change to show, as the open row draws no dot. */
    seen: (id: string, finished: number) => queue(id, ["seen", id, String(finished)], {}, ""),
    /** Rust's rows came: what each action waits for. */
    caught(list: Marked[] | undefined) {
      rows = new Map(list?.map((row) => [row.id, row]));
      for (const id of queues.get().keys()) settle(id);
    },
  };
}

/** The rows as they show: Rust's, with each action still going laid over in order. */
export function laidOver<R extends Marked>(list: R[] | undefined, pending: Map<string, Action[]>): R[] | undefined {
  return list?.map((row) =>
    (pending.get(row.id) ?? []).reduce<R>(
      (shown, { change }) => ({
        ...shown,
        ...(change.pinned !== undefined && { pinned: change.pinned }),
        ...(change.title !== undefined && { title: change.title }),
        ...(change.archived !== undefined && { archived: change.archived }),
        ...(change.label && { labels: [...(shown.labels ?? []).filter((name) => name !== change.label!.name), ...(change.label.on ? [change.label.name] : [])] }),
      }),
      row,
    ),
  );
}

/** Archived, or a delete that left something: among the archived, not the live rows [D35]. */
export const closed = (row: Pick<Row, "archived" | "lifecycle">) => Boolean(row.archived) || row.lifecycle?.op === "delete";
/** A delete under way: hidden; one that left something comes back among the archived with what stayed. */
export const deleting = (row: Pick<Row, "lifecycle">) => row.lifecycle?.op === "delete" && !row.lifecycle.left;

const titleOf = (row: { title: string }) => `“${row.title || "New session"}”`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Archive's confirm, from Rust's check (proposed words) [D179, D1197]. */
export const archiveAsk = (rows: { title: string }[]) =>
  rows.length === 1
    ? { title: "Archive session?", description: `This archives ${titleOf(rows[0]!)}. Restore brings it back.`, confirm: "Archive" }
    : { title: `Archive ${rows.length} sessions?`, description: "Restore brings each one back.", confirm: "Archive" };
export const unchecked = (error: string) => `Couldn't check what archiving loses: ${error}`;
/** A working agent archive stops; `title` the session's when several are archived. */
export const workingLine = (title?: string) => (title === undefined ? "Its agent is working and will be stopped." : `${title} is working; its agent will be stopped.`);
/** Names in a line: five, then how many more. */
export const listed = (names: string[]) => (names.length > 5 ? `${names.slice(0, 5).join(", ")} and ${names.length - 5} more` : names.join(", "));
/** Per folder an archive or delete frees, what it loses for good; `repos`, a delete's repositories in it. */
export type Lost = { ids: string[]; files?: string[]; repos?: string[]; error?: string };
/** What one folder loses for good, before the names that follow it: a delete's repositories, else its ignored files. */
export const lostLead = (lost: Pick<Lost, "repos">, more = "") =>
  lost.repos
    ? `${lost.repos.length === 1 ? "The repository in it is" : `The ${lost.repos.length} repositories in it are`} deleted for good, even if a branch is kept`
    : `Its ignored files are deleted for good${more}`;
/** Its whole line, or why it couldn't be listed. */
export const lostText = (lost: Lost, more = "") =>
  lost.error !== undefined ? `Couldn't list its ignored files: ${lost.error}` : `${lostLead(lost, more)}: ${listed(lost.repos ?? lost.files ?? [])}.`;
export const ARCHIVE_LOSES = ", and restore won't bring them back";

/**
 * Delete's confirm, for one session or several [D35]: one line. Delete keeps a branch with work that never landed
 * [D181]; Rust's check only adds the workers it stops (`running`, beside those deleted).
 */
export function deleteAsk(rows: { title: string }[], running: number) {
  const one = rows.length === 1 ? rows[0]! : null;
  const many = `${rows.length} sessions`;
  const stop = running > 0 ? ` ${one ? "Its" : "Their"} ${plural(running, "running worker stops", "running workers stop")}.` : "";
  return { title: one ? `Delete ${titleOf(one)}?` : `Delete ${many}?`, description: `This can't be undone.${stop}`, confirm: one ? "Delete session" : `Delete ${many}` };
}
/** Why a delete didn't go: what stayed first, else Rust's reason. */
export const deleteFailed = (row: { title: string }, reply: Frame) =>
  `Couldn't delete ${titleOf(row)}: ${reply.left?.[0] ?? (reply.error === "disconnected" ? "Brigadier isn't running" : (reply.message ?? reply.error ?? "it failed"))}`;
