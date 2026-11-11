import { Button } from "../components/button";
import { ROW } from "../components/thread/activity-row";
import { Check } from "../icons";
import { XCircle } from "./icons";

/**
 * "Checks failed on #12 · test (ubuntu-latest)" at the thread's end [D1017], with Send to agent, which leaves a chip
 * above the composer and sends nothing [D1019, D1027], and Open, the PR tab. Added once its chip is waiting.
 */
export function ChecksFailedRow({
  number,
  checks,
  added = false,
  offline = false,
  onSend,
  onOpen,
}: {
  number: number;
  /** The failing checks' names. */
  checks: string[];
  added?: boolean;
  offline?: boolean;
  onSend: () => void;
  onOpen: () => void;
}) {
  return (
    <div data-slot="checks-failed-row" className="flex items-center gap-2">
      <div className={ROW}>
        <XCircle aria-hidden className="size-4 shrink-0 text-destructive" />
        <span className="min-w-0 truncate">
          Checks failed on #{number} · {checks.join(", ")}
        </span>
      </div>
      <Button variant="soft" size="xs" disabled={added || offline} onClick={onSend}>
        {added && <Check />}
        {added ? "Added" : "Send to agent"}
      </Button>
      <Button variant="soft" size="xs" onClick={onOpen}>
        Open
      </Button>
    </div>
  );
}
