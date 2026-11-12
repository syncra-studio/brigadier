import { Meter } from "@base-ui/react/meter";

import { cx } from "./cx";

/** A thin meter, the old app's: a muted capsule track filled to `value` percent in `fill`. */
export function UsageBar({ value, fill, label, className }: { value: number; fill: string; label: string; className?: string }) {
  return (
    <Meter.Root value={value} aria-label={label} className={cx("flex shrink-0", className)}>
      <Meter.Track className="flex h-1 w-full overflow-hidden rounded-capsule bg-muted">
        {/* Base UI sets the fill's width. */}
        <Meter.Indicator className={cx("h-full rounded-capsule motion-safe:transition-width", fill)} />
      </Meter.Track>
    </Meter.Root>
  );
}
