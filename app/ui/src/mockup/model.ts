// A session's mockup as Rust folds it from its mockup worker [D2055, D2056]: the rounds, each with the named variants
// drawn so far, the pick, and the real screen it was built into.
import type { MockupNote, Notes } from "./notes";

/** One named variant of a round: a live fixture page and its screenshot, the fallback [D2059]. */
export type Variant = { letter: string; name: string; why?: string | null; url?: string | null; shot?: string | null };

/** A round: the variants drawn so far, whether it still draws, and the notes sent on it, which start the next. */
export type Round = { variants: Variant[]; drawing: boolean; sent: MockupNote[] };

export type Mockup = {
  title: string;
  /** How many variants were asked for: 3 or 1 [D2067]. */
  count: number;
  rounds: Round[];
  /** The variant the user picked with Use, once they did. */
  picked: string | null;
  /** The round it was picked from, 1-based: Compare shows that round's fixture. */
  pickedRound?: number | null;
  /** The picked variant being wired into the app [D2068]. */
  building: boolean;
  /** The real screen it was wired into, once it is [D2069]. */
  real: string | null;
  /** The user stopped the mockup worker; notes can't reach it [D560]. */
  stopped: boolean;
  /** The notes not sent yet, kept by Rust so they survive closing the tab [D2055]. */
  draft?: Notes | null;
};

/** A live frame's page: loading, or it didn't load. Shown otherwise. */
export type Load = "loading" | "failed";

export const LETTERS = ["A", "B", "C"] as const;

/** A round's variants by letter, those not drawn yet as placeholders with no name. */
export const slots = (mockup: Mockup, round: Round): Variant[] =>
  LETTERS.slice(0, mockup.count).map((letter) => round.variants.find((v) => v.letter === letter) ?? { letter, name: "" });

/** Whether a variant is drawn: it has a page or a screenshot. */
export const drawn = (variant: Variant) => Boolean(variant.url || variant.shot);

/** The mockup's busy work: a round drawing or the pick being wired in; the tab's spinner shows only then. */
export const busy = (mockup: Mockup | null) => Boolean(mockup && !mockup.stopped && (mockup.building || mockup.rounds.at(-1)?.drawing));

/** The header's status word: Drawing 2 of 3…, nothing once ready, Stopped, Building B into the app…, B built into the app. */
export function statusOf(mockup: Mockup): string | null {
  const last = mockup.rounds.at(-1);
  if (mockup.real && mockup.picked) return `${mockup.picked} built into the app`;
  if (mockup.stopped) return "Stopped";
  if (mockup.building && mockup.picked) return `Building ${mockup.picked} into the app…`;
  if (!last?.drawing) return null;
  if (mockup.rounds.length > 1) return `Drawing round ${mockup.rounds.length}…`;
  const done = last.variants.filter(drawn).length;
  return `Drawing ${Math.min(done + 1, mockup.count)} of ${mockup.count}…`;
}
