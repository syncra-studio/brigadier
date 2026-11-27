// The composer's state, one per paired Mac [D58], from the shared session logic wired as the desktop's
// app/ui/src/session/{draft,uncertain,sent}.ts and panel/chips.ts wire it.
import { File, Paths } from "expo-file-system";
import { uuid } from "expo-modules-core";
import type { Chip as PanelChip } from "../../vendor/brigadier-shared/chips";
import { draftState } from "../../vendor/brigadier-shared/session/draft";
import { modelState } from "../../vendor/brigadier-shared/session/model";
import type { Runner } from "../../vendor/brigadier-shared/session/run";
import { sendState } from "../../vendor/brigadier-shared/session/sent";
import { uncertainState } from "../../vendor/brigadier-shared/session/uncertain";
import { store } from "../../vendor/brigadier-shared/store";
import { macNow, request, streamNow } from "../link";
import { keepImage } from "../thread/Image";

// What the shared logic takes from a browser: an id maker and a store for messages on their way.
const g = globalThis as any;
g.crypto ??= {};
g.crypto.randomUUID ??= () => uuid.v4();
if (!g.localStorage) {
  // shortcut: kept in memory, so a message on its way outlives leaving its thread but not a relaunch (the Mac's book keeps each it got); upgrade with a storage package.
  const kept = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, String(v)), removeItem: (k: string) => void kept.delete(k) };
}

export const newId = (): string => crypto.randomUUID();

/** A `brigadier` command on the connected Mac, answered with its reply, a refusal included; with no stream, refused with why. */
const ask: Runner = (args) =>
  new Promise((done) => {
    const closed = { ok: false, error: "closed", message: "Not connected to your Mac" };
    try {
      request({ op: "run", args }, (reply) => done(reply.error === "closed" && !reply.message ? closed : reply));
    } catch {
      done(closed);
    }
  });

const NONE: readonly PanelChip[] = [];

/**
 * What waits above a session's composer for the agent (the Mac's diff comments, a Fix or Resolve with agent), as
 * Rust keeps it (`chips <id>`). A phone reads them and sends them with its next message, never adds or drops one.
 */
function chipState(uncertain: ReturnType<typeof uncertainState>, run: Runner) {
  const chips = store<ReadonlyMap<string, readonly PanelChip[]>>(new Map());
  // Taken by a message here: a read doesn't bring them back.
  const gone = new Set<string>();
  // Rust's chips a read held back for a message kept here: they wait again if Rust gave it back.
  const withheld = new Map<string, readonly PanelChip[]>();
  const of = (id: string) => chips.get().get(id) ?? NONE;
  const put = (id: string, list: readonly PanelChip[]) => chips.set(new Map(chips.get()).set(id, list));
  function load(id: string) {
    void run(["chips", id]).then((reply) => {
      if (!reply.ok) return;
      // A tool pill saved before tools were chips in the text goes, as the desktop's.
      const theirs = (reply.chips as { kind: string }[]).filter((chip): chip is PanelChip => chip.kind !== "tool");
      const held = uncertain.heldChips(id);
      withheld.set(id, theirs.filter((chip) => held.has(chip.id)));
      put(id, theirs.filter((chip) => !gone.has(chip.id) && !held.has(chip.id)));
    });
  }
  const leave = (id: string, sent: readonly PanelChip[]) => {
    for (const chip of sent) gone.add(chip.id);
    put(id, of(id).filter((chip) => !sent.some((each) => each.id === chip.id)));
  };
  uncertain.onChipsBack((id, given, ids = []) => {
    const back = [...given, ...(withheld.get(id) ?? NONE).filter((chip) => ids.includes(chip.id) && !given.some((each) => each.id === chip.id))];
    if (back.length === 0) return;
    for (const chip of back) gone.delete(chip.id);
    put(id, [...back, ...of(id).filter((chip) => !back.some((each) => each.id === chip.id))]);
  });
  return { chips, of, load, leave };
}

/** A file of the composer's: stored by Rust under its session's folder, settled by its id, failed with why [D127, D487]. */
export type Attachment = { id: string; name: string; mime: string; state: "uploading" | "ready" | "failed"; error?: string };
type Files = { all: ReadonlyMap<string, Attachment>; tiles: readonly string[] };
const NO_FILES: Files = { all: new Map(), tiles: [] };
/** A file picked on this phone, as a copy in the app's cache. */
export type Picked = { uri: string; name: string; mime?: string | null; size?: number | null };
/** Rust's `MAX_BYTES` (crates/core/src/message.rs), in the CLI's words when a file is over it. */
const MAX_BYTES = 10 * 1024 * 1024;
const TOO_LARGE = "File is too large to upload (maximum 10 MB)";

/**
 * Each session's files, as the desktop's session/files.tsx keeps them: every one there (`all`) and the tiles over the
 * field, which go with the next message as its `attachmentIds`. Kept while the app runs, so leaving the thread keeps them.
 */
function fileState(run: Runner) {
  const owners = store<ReadonlyMap<string, Files>>(new Map());
  const of = (owner: string) => owners.get().get(owner) ?? NO_FILES;
  const change = (owner: string, next: (files: Files) => Files) => owners.set(new Map(owners.get()).set(owner, next(of(owner))));
  const set = (owner: string, file: Attachment) => change(owner, (files) => ({ ...files, all: new Map(files.all).set(file.id, file) }));
  const listed = new Set<string>();
  // Moves on at each list asked and each file attached: a list answers only for files attached before it was asked.
  let tick = 0;
  const began = new Map<string, number>();
  /**
   * After a restart, a draft's files' names come back from Rust's folder, by their ids; `again` reads it again (a new
   * connection). A tile Rust's folder hasn't (one that was still uploading, or failed) shows failed, to be removed.
   */
  function load(owner: string, again = false) {
    if (listed.has(owner) && !again) return;
    listed.add(owner);
    const at = ++tick;
    void run(["attach", owner, "list"]).then((reply) => {
      if (!reply.ok) return void listed.delete(owner);
      const there = new Map<string, { id: string; name: string; mime: string }>((reply.files ?? []).map((each: { id: string; name: string; mime: string }) => [each.id, each]));
      for (const each of there.values()) if (!of(owner).all.has(each.id)) set(owner, { ...each, state: "ready" });
      // Each settled tile as Rust's folder has it: listed is ready (an add whose reply was lost), missing is failed.
      for (const id of of(owner).tiles) {
        const now = of(owner).all.get(id);
        if ((began.get(id) ?? 0) > at || now?.state === "uploading") continue;
        const listed = there.get(id);
        if (listed) set(owner, { id, name: now?.name ?? listed.name, mime: now?.mime ?? listed.mime, state: "ready" });
        // One that failed here keeps its own why (too large, refused).
        else if (now?.state !== "failed") set(owner, { id, name: now?.name ?? "File", mime: now?.mime ?? "application/octet-stream", state: "failed", error: "This file is no longer on your Mac" });
      }
    });
  }
  // One store at a time, so each counts the files before it (`--in`), as Rust holds a message to 20.
  let storing: Promise<void> = Promise.resolve();
  // Each file's store, which a remove of it waits for, so its add never lands after the remove.
  const stores = new Map<string, Promise<void>>();
  /** Shows `picked` at once and hands it to Rust; its copy in the cache goes once it has been read and sent. */
  function attach(owner: string, picked: Picked, backend: string | undefined) {
    const id = newId();
    // Rust keeps it by a name with no folder in it, not hidden, never read as a flag.
    const name = picked.name.replace(/\//g, "_").replace(/^[.-]+/, "") || "File";
    const mime = picked.mime || "application/octet-stream";
    const fail = (error: string) => set(owner, { id, name, mime, state: "failed", error });
    began.set(id, ++tick);
    set(owner, { id, name, mime, state: "uploading" });
    change(owner, (files) => ({ ...files, tiles: [...files.tiles, id] }));
    const file = new File(picked.uri);
    const job = (storing = storing.then(async () => {
      try {
        // Taken out before its turn: not stored.
        if (!of(owner).tiles.includes(id)) return;
        if ((picked.size ?? file.size) > MAX_BYTES) return fail(TOO_LARGE);
        const data = await file.base64();
        // Taken out while it was read.
        if (!of(owner).tiles.includes(id)) return;
        const others = of(owner).tiles.filter((each) => each !== id && of(owner).all.get(each)?.state === "ready");
        const reply = await run(["attach", owner, "add", id, name, ...(backend ? ["--backend", backend] : []), ...(others.length > 0 ? ["--in", others.join(",")] : []), "--data", data]);
        if (!reply.ok) return fail(String(reply.message ?? reply.error ?? "Couldn't attach this file"));
        if (mime.startsWith("image/")) keepImage(owner, id, `data:${mime};base64,${data}`);
        // A list asked before this add went through can't speak for it.
        began.set(id, ++tick);
        set(owner, { id, name, mime, state: "ready" });
      } catch {
        fail("Couldn't read this file");
      } finally {
        try {
          if (file.uri.startsWith(Paths.cache.uri) && file.exists) file.delete();
        } catch {
          // Gone already; the system clears the cache in time.
        }
      }
    }));
    stores.set(id, job);
    void job.then(() => stores.delete(id));
  }
  const remove = (owner: string, id: string) => {
    change(owner, (files) => ({ ...files, tiles: files.tiles.filter((each) => each !== id) }));
    void (stores.get(id) ?? Promise.resolve()).then(() => run(["attach", owner, "remove", id]));
  };
  /** Tiles back (a draft read, a message given back), anything added meanwhile kept; ones not listed yet are read. */
  const restore = (owner: string, tiles: readonly string[]) => {
    if (tiles.length === 0) return;
    change(owner, (files) => ({ ...files, tiles: [...new Set([...tiles, ...files.tiles])] }));
    if (tiles.some((id) => !of(owner).all.has(id))) {
      listed.delete(owner);
      load(owner);
    }
  };
  /** The tiles leave with a message: its files are the session's now. */
  const sent = (owner: string) => change(owner, (files) => ({ ...files, tiles: [] }));
  return { owners, of, load, attach, remove, restore, sent };
}

function macState(pk: string) {
  /** The sessions whose draft couldn't be saved or read here: their composer does it again once this Mac is connected. */
  const unsaved = new Set<string>();
  /** This Mac's commands, never another's: a save timed before a switch is refused, not sent to the Mac now connected. */
  const run: Runner = async (args) => {
    const reply = macNow() === pk ? await ask(args) : { ok: false, error: "closed", message: "Not connected to this Mac" };
    if (args[0] === "draft" && reply.error === "closed") unsaved.add(args[1]);
    return reply;
  };
  const uncertain = uncertainState(`brigadier.uncertain.${pk}.`);
  const drafts = draftState(uncertain);
  const sends = sendState(uncertain, drafts, { connection: streamNow, sendFailed: () => {} });
  /** The queued message this phone pulled back to edit, by session: Rust's one `editing` may be another device's. */
  const edits = new Map<string, { qid: string; slot: number; text: string }>();
  /** A `!` command whose reply was lost, by session: confirmed again, it keeps its id, so the Mac runs it once. */
  const shells = new Map<string, { line: string; qid: string }>();
  return { run, unsaved, uncertain, drafts, sends, chips: chipState(uncertain, run), files: fileState(run), models: modelState(), edits, shells };
}

const macs = new Map<string, ReturnType<typeof macState>>();
/** The signed-in Mac's composer state. */
export function forMac() {
  const pk = macNow();
  if (!macs.has(pk)) macs.set(pk, macState(pk));
  return macs.get(pk)!;
}

/**
 * The chips as the agent reads them, after the user's own words: as the desktop's panel/chips.ts `withChips`, each
 * comment's place, its lines quoted, then what it says.
 */
export function withChips(message: string, sent: readonly PanelChip[]): string {
  const blocks = sent.map((chip) => {
    if (chip.kind === "agent") return chip.text;
    const { on, comment } = chip;
    const lines = comment.start === comment.end ? `${comment.start}` : `${comment.start}-${comment.end}`;
    const where = [on !== "review" && `in commit ${on.slice(0, 12)}`, comment.side === "deletions" && "before the change"].filter(Boolean).join(", ");
    return `${comment.path}:${lines}${where ? ` (${where})` : ""}\n${comment.excerpt.split("\n").map((line) => `> ${line}`).join("\n")}\n\n${comment.text}`;
  });
  return [message.trim(), ...blocks].filter(Boolean).join("\n\n");
}
