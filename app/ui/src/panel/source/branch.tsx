import { clock } from "../words";

/** "Offline · 14:32": when the checkout was last read, beside the branch on the card [D30, D1206]. */
export function Offline({ readAtMs }: { readAtMs: number | null }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className="size-1.5 rounded-capsule bg-warning" />
      {readAtMs === null ? "Offline" : `Offline · ${clock(readAtMs)}`}
    </span>
  );
}
