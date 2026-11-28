import "./overnight.css";

import { Button } from "../components/button";
import { ComposerPill, PillDivider } from "../components/composer/composer";
import { ActionCardActions } from "../components/composer/decision-parts";
import { RailItem } from "../components/composer/rail";
import { cx } from "../components/cx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Moon } from "../icons";
import { MAC } from "../onboarding/parts";
import { duration, useSecond } from "../thread/words";
import { type Overnight, overnight } from "./overnight";
import { NIGHT_WORDS as N, nightProgress } from "../../../shared/session/composer";

/** The composer's look while Overnight is on. */
export const nightLook = (on: boolean) => (on ? "night-sky" : undefined);

/** The Overnight pill, after the permission pill. */
export function OvernightPill({ on, tip, onChange }: { on: boolean; tip?: string; onChange: (on: boolean) => void }) {
  return (
    <>
      <PillDivider />
      <Tooltip>
        <TooltipTrigger render={<ComposerPill aria-pressed={on} data-slot="overnight-pill" className={cx("aria-pressed:bg-picked-row", on && "moonlit")} onClick={() => onChange(!on)} />}>
          <Moon />
          <span>{N.pill}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tip ?? (on ? N.off : N.on)}</TooltipContent>
      </Tooltip>
    </>
  );
}

/** A session's pill: clicked in the night, the user is back. */
export function SessionOvernight({ id, now }: { id: string; now: Overnight | null }) {
  return <OvernightPill on={now !== null} tip={now?.state === "night" ? N.back : undefined} onChange={(on) => overnight(id, on ? "on" : "off")} />;
}

/** Start night, under what is asked before the user goes, whose answers go first (`finish`). */
export function StartNight({ id, label, finish, waits, busy }: { id: string; label: string; finish?: () => Promise<boolean>; waits?: string; busy?: boolean }) {
  return (
    <ActionCardActions leading={<span className="min-w-0 flex-1 text-xs text-muted-foreground">{label}</span>}>
      <Button size="sm" disabled={busy || waits !== undefined} title={waits} onClick={() => overnight(id, "start", finish?.())}>
        <Moon />
        {N.start}
      </Button>
    </ActionCardActions>
  );
}

/** All it needs is answered: what it does alone, and Start night. */
export function NightReady({ id, now }: { id: string; now: Overnight | null }) {
  const shown = now?.state === "ready";
  return (
    <RailItem variant="decision" label={N.beforeYouGo} shown={shown}>
      <div className="flex flex-col gap-1 px-4 pt-4">
        <p className="text-sm font-medium">{N.ready}</p>
        {now?.words && <p className="text-label text-muted-foreground">{now.words}</p>}
      </div>
      <StartNight id={id} label={N.awake(MAC)} />
    </RailItem>
  );
}

/** What a look in at night says, on the rail: how long, how far, and the way back. */
export function OvernightStrip({ id, now }: { id: string; now: Overnight | null }) {
  const night = now?.state === "night" ? now : null;
  const tick = useSecond(night !== null);
  return (
    <RailItem label={N.pill} shown={night !== null}>
      <div className="flex items-center gap-2 px-3.5 py-2 text-sm">
        <Moon className="moonlit size-icon-md shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {night?.since ? `${duration(tick - night.since)} in` : N.pill}
          <span className="text-muted-foreground">{night ? nightProgress(night) : ""}</span>
        </span>
        <Button size="xs" variant="soft" onClick={() => overnight(id, "off")}>
          {N.imBack}
        </Button>
      </div>
    </RailItem>
  );
}
