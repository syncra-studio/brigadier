import { cx } from "../components/cx";
import { Segment, SegmentedRoot } from "../components/segmented";

/** The thread's two layouts: centered with your messages as bubbles, or full width and stacked [D914, D915]. */
export type ChatLayout = "bubbles" | "stacked";

const CHOICES: { mode: ChatLayout; label: string }[] = [
  { mode: "bubbles", label: "Bubbles" },
  { mode: "stacked", label: "Stacked" },
];

/** A tiny thread: centered with your message as a bubble on the right, or across the panel with it as a full-width block. */
function ChatLayoutPicture({ mode }: { mode: ChatLayout }) {
  const stacked = mode === "stacked";
  return (
    <div className="flex h-14 w-24 flex-col rounded-settings border border-divider bg-background p-1 transition-shadow group-focus-visible:focus-ring group-data-pressed:ring-2 group-data-pressed:ring-ring">
      <div className={cx("flex flex-1 flex-col justify-end gap-1 py-0.5", stacked ? "px-0.5" : "mx-auto w-3/5")}>
        <div className={cx("h-1.5 rounded-full bg-live-text-quiet", stacked ? "w-full rounded-xs" : "ml-auto w-3/5")} />
        <div className="h-0.5 w-full rounded-full bg-queue-glyph" />
        <div className="h-0.5 w-4/5 rounded-full bg-queue-glyph" />
        <div className="h-0.5 w-11/12 rounded-full bg-queue-glyph" />
      </div>
      <div className={cx("mt-1 h-2 rounded-full bg-input-disabled", stacked ? "w-full" : "mx-auto w-3/5")} />
    </div>
  );
}

/** The two layouts as pictures to pick from, the old app's Sidebar row. A choice is always made: picking the chosen one again keeps it, and says so. */
export function ChatLayoutChoice({ label, value, onChange }: { label: string; value: ChatLayout; onChange: (mode: ChatLayout) => void }) {
  return (
    <SegmentedRoot aria-label={label} value={[value]} onValueChange={([next]) => onChange((next ?? value) as ChatLayout)} className="flex gap-3">
      {CHOICES.map((choice) => (
        <Segment
          key={choice.mode}
          value={choice.mode}
          className="group flex cursor-pointer flex-col items-center gap-1.5 rounded-settings p-1 text-xs text-row-foreground transition-colors outline-none hover:text-foreground data-pressed:text-foreground"
        >
          <ChatLayoutPicture mode={choice.mode} />
          <span className="font-medium">{choice.label}</span>
        </Segment>
      ))}
    </SegmentedRoot>
  );
}
