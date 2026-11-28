// How the mockup shows outside its tab: a row in the chat with Open [D2055, D2066, D560], and the tab's icon, the
// busy spinner only while a round draws or the pick is wired in, told to screen readers after its title (the old tab's).
import { StateDot } from "../components/state-dot";
import { ROW } from "../components/thread/activity-row";
import { ImageSquare, Spinner } from "../icons";

export type { MockupMoment } from "../../../shared/words";
import { type MockupMoment, mockupName as named, mockupWords as words } from "../../../shared/words";

/** "Plan card mockup · drawing 3 variants · Open": Open brings its tab to the front. */
export function MockupRow({ title, moment, live, onOpen }: { title?: string; moment: MockupMoment; live: boolean; onOpen: () => void }) {
  const [lead, rest] = words(moment, named(title));
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

/** A mockup tab's icon: the spinner while busy, as a running row shows; the blue dot while its news is unseen, as a row's reply. */
export function MockupTabIcon({ busy, unread = false }: { busy: boolean; unread?: boolean }) {
  if (busy) return <Spinner data-slot="mockup-tab-busy" className="size-icon-sm shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />;
  return unread ? <StateDot tone="unread" label="New in the mockup" /> : <ImageSquare className="size-icon-sm shrink-0" />;
}

/** Says a mockup's tab is busy to assistive tech, after its title. */
export function MockupTabStatus({ busy, building }: { busy: boolean; building: boolean }) {
  return busy ? <span className="sr-only">{building ? ", being built into the app" : ", building"}</span> : null;
}
