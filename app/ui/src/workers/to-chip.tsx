import { ComposerPill, PillDivider } from "../components/composer/composer";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { WorkerGlyph } from "../icons/worker-glyphs";
import type { Worker } from "./chip";

/**
 * The composer's To: chip, as the old app's ToWorkerChip [D3013]: while it shows, the next message goes to that worker
 * alone (picked from the @ menu's "Message directly"); a click takes it back. Drawn for the gallery only: it joins the
 * composer once wave 3's composer work has landed [D561].
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
