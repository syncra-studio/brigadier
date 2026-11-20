import { ComposerPill, PillDivider } from "../components/composer/composer";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
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
