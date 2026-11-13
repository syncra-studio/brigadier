import { useEffect, useState } from "react";

import { ComposerPill, PillDivider } from "../components/composer/composer";
import { showToast } from "../components/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { type Row, useDaemon } from "../daemon";
import { Nodes, type IconProps } from "../icons";
import { errorText, run } from "../onboarding/api";

/** A Brigade's mark: one over several [D194]. */
export const BrigadeGlyph = (props: IconProps) => <Nodes {...props} />;

/**
 * The composer's Brigade pill, after the permission pill as the old app's FusionChip [D185]: while it's on, each
 * message tells the agent to lead the job as the boss of sessions of its own. It shows at once; Rust's row settles
 * it [D30]. A worker and a Brigade's own session have none.
 */
export function BrigadeToggle({ id, row }: { id: string; row: Row | undefined }) {
  const [want, setWant] = useState<boolean | null>(null);
  const on = want ?? row?.brigade === true;
  useEffect(() => {
    if (want !== null && row?.brigade === want) setWant(null);
  }, [row?.brigade, want]);
  if (!row || row.worker || row.boss) return null;
  const flip = () => {
    const next = !on;
    setWant(next);
    run(["workers", id, "brigade", next ? "on" : "off"]).catch((cause: unknown) => {
      setWant(null);
      showToast(`Couldn't turn Brigade ${next ? "on" : "off"}: ${errorText(cause)}`, { tone: "error" });
    });
  };
  return (
    <>
      <PillDivider />
      <Tooltip>
        <TooltipTrigger render={<ComposerPill aria-pressed={on} data-slot="brigade-pill" className="aria-pressed:bg-fill aria-pressed:text-foreground" onClick={flip} />}>
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
