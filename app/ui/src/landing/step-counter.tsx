import { ChevronDown, ChevronUp } from "../icons";

const ARROW = "rounded-control p-0.5 enabled:hover:text-foreground focus-visible:focus-ring disabled:opacity-disabled svg:size-icon-xs";

/** Up and down arrows between a file's conflicts, as the old StepCounter drew them (`vertical`). `noun` names them. */
export function StepCounter({ noun, onStep, enabled }: { noun: string; onStep: (step: -1 | 1) => void; enabled: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
      <button type="button" aria-label={`Previous ${noun}`} className={ARROW} disabled={!enabled} onClick={() => onStep(-1)}>
        <ChevronUp />
      </button>
      <button type="button" aria-label={`Next ${noun}`} className={ARROW} disabled={!enabled} onClick={() => onStep(1)}>
        <ChevronDown />
      </button>
    </span>
  );
}
