// How the mockup shows outside its tab: a row in the chat with Open [D2055, D2066, D560], and the tab's icon, the
// busy spinner only while a round draws or the pick is wired in, told to screen readers after its title (the old tab's).
import { StateDot } from "../components/state-dot";
import { ROW } from "../components/thread/activity-row";
import { ImageSquare, Spinner } from "../icons";

/** One moment of the mockup, as its chat row tells it. */
export type MockupMoment =
  | { kind: "drawing"; count: number }
  | { kind: "ready"; round: number | null; open: boolean }
  | { kind: "waiting" }
  | { kind: "notes"; count: number; on: string[]; round: number }
  | { kind: "picked"; letter: string }
  | { kind: "built"; letter: string }
  | { kind: "stopped" };

const notes = (n: number) => (n === 1 ? "1 note" : `${n} notes`);

/** "A", "A and B", "A, B and C". */
const listed = (names: string[]) => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

function words(moment: MockupMoment): [string, string] {
  switch (moment.kind) {
    case "drawing":
      return ["Mockup", moment.count === 1 ? "drawing 1 variant" : `drawing ${moment.count} variants`];
    case "ready":
      // Still the newest round, nothing picked: the user's move.
      if (!moment.open) return ["Mockup", `round ${moment.round ?? 1} ready`];
      return [moment.round ? `Mockup · round ${moment.round} ready` : "Mockup ready", "pick one with Use, or leave a note"];
    case "waiting":
      // Its worker's turn ended before the round was all in.
      return ["Mockup", "waiting for your notes"];
    case "notes":
      return ["You → mockup", `${notes(moment.count)} on ${listed(moment.on)} · round ${moment.round} drawing`];
    case "picked":
      return [`You picked ${moment.letter}`, "building for real"];
    case "built":
      return ["Mockup", `${moment.letter} built into the app`];
    case "stopped":
      return ["Mockup", "stopped"];
  }
}

/** "Mockup · drawing 3 variants · Open": Open brings the Mockup tab to the front. */
export function MockupRow({ moment, live, onOpen }: { moment: MockupMoment; live: boolean; onOpen: () => void }) {
  const [lead, rest] = words(moment);
  return (
    <p className={ROW}>
      {live ? <Spinner className="size-icon-sm shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" /> : <ImageSquare className="size-icon-sm shrink-0" />}
      <span className="font-medium text-foreground">{lead}</span>
      <span className="min-w-0 truncate">· {rest} ·</span>
      <button type="button" className="shrink-0 cursor-pointer rounded-control text-link hover:underline focus-visible:focus-ring" onClick={onOpen}>
        Open
      </button>
    </p>
  );
}

/** The Mockup tab's icon: the spinner while busy, as a running row shows; the blue dot while its news is unseen, as a row's reply. */
export function MockupTabIcon({ busy, unread = false }: { busy: boolean; unread?: boolean }) {
  if (busy) return <Spinner data-slot="mockup-tab-busy" className="size-icon-sm shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />;
  return unread ? <StateDot tone="unread" label="New in the mockup" /> : <ImageSquare className="size-icon-sm shrink-0" />;
}

/** Says the Mockup tab is busy to assistive tech, after its title. */
export function MockupTabStatus({ busy, building }: { busy: boolean; building: boolean }) {
  return busy ? <span className="sr-only">{building ? ", being built into the app" : ", building"}</span> : null;
}
