// The composer's state, one per paired Mac [D58], from the shared session logic wired as the desktop's
// app/ui/src/session/{draft,uncertain,sent}.ts and panel/chips.ts wire it.
import { uuid } from "expo-modules-core";
import type { Chip as PanelChip } from "../../vendor/brigadier-shared/chips";
import { draftState } from "../../vendor/brigadier-shared/session/draft";
import { modelState } from "../../vendor/brigadier-shared/session/model";
import type { Runner } from "../../vendor/brigadier-shared/session/run";
import { sendState } from "../../vendor/brigadier-shared/session/sent";
import { uncertainState } from "../../vendor/brigadier-shared/session/uncertain";
import { store } from "../../vendor/brigadier-shared/store";
import { macNow, request, streamNow } from "../link";

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
  return { run, unsaved, uncertain, drafts, sends, chips: chipState(uncertain, run), models: modelState(), edits };
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
