import { ComposerPill, PillDivider } from "../components/composer/composer";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { useDaemon } from "../daemon";
import { Nodes, type IconProps } from "../icons";

/** A Brigade's mark: one over several [D194]. */
export const BrigadeGlyph = (props: IconProps) => <Nodes {...props} />;

/**
 * New chat's Brigade pill, after the permission pill as the old app's FusionChip [D185]: on, the session starts as a
 * Brigade, its agent leading the job as the boss of sessions of its own. Only a new chat has it: a session is a
 * Brigade from its first message or never, which Rust holds [D209].
 */
export function BrigadeToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <>
      <PillDivider />
      <Tooltip>
        <TooltipTrigger render={<ComposerPill aria-pressed={on} data-slot="brigade-pill" className="aria-pressed:bg-fill aria-pressed:text-foreground" onClick={() => onChange(!on)} />}>
          <BrigadeGlyph />
          <span>Brigade</span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{on ? "Turn Brigade off" : "Brigade: this session leads the job through sessions of its own"}</TooltipContent>
      </Tooltip>
    </>
  );
}

/** Above a message sent with Brigade on, as the old app's FusionMessagePill. */
export function BrigadeMessagePill() {
  return (
    <span className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground">
      <BrigadeGlyph className="size-icon-sm" />
      Brigade
    </span>
  );
}

/** A Brigade's session's tab starts with its Brigade, one click back to it [D196]. */
export function BossCrumb({ boss }: { boss: string | null | undefined }) {
  const row = useDaemon().rows?.find((each) => each.id === boss);
  if (!row) return null;
  return (
    <>
      <button type="button" title={`Back to ${row.title}`} onClick={() => (window.location.hash = `#thread/${encodeURIComponent(row.id)}`)} className="flex max-w-20 min-w-0 shrink cursor-pointer items-center gap-1 rounded-sm text-muted-foreground hover:text-foreground focus-visible:focus-ring">
        <BrigadeGlyph className="size-icon-sm shrink-0" />
        <span className="truncate">{row.title || "Brigade"}</span>
      </button>
      <span aria-hidden className="shrink-0 text-muted-foreground">›</span>
    </>
  );
}
