import { ComposerPill, PillDivider } from "../components/composer/composer";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { WorkerGlyph } from "../icons/worker-glyphs";
import type { Worker } from "./chip";

/**
 * The composer's To: chip, as the old app's ToWorkerChip [D3013]: while it shows, the next message goes to that worker
 * alone (picked from the @ menu's "Message directly"); a click takes it back.
 */
export function ToWorkerChip({ worker, sending = false, onClear }: { worker: Worker; sending?: boolean; onClear: () => void }) {
  return (
    <>
      <PillDivider />
      <Tooltip>
        <TooltipTrigger render={<ComposerPill aria-pressed data-slot="to-worker-chip" className="max-w-48" disabled={sending} onClick={onClear} />}>
          <WorkerGlyph id={worker.id} />
          <span className="truncate">To {worker.name}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom">Send to this session instead</TooltipContent>
      </Tooltip>
    </>
  );
}

/** A queued row for a busy worker, as the old app's QueueCard ToWorker: it goes as that worker's next turn [D3050]. */
export function ToWorker({ name }: { name: string | null }) {
  return <span className="min-w-0 shrink-8 truncate text-xs text-muted-foreground">To {name ?? "a worker"}</span>;
}
