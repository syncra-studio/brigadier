import { Switch as BaseSwitch } from "@base-ui/react/switch";

import { cx } from "./cx";

/** An on/off switch: blue when on, its thumb sliding across. */
export function Switch({ className, ...props }: Omit<BaseSwitch.Root.Props, "className"> & { className?: string }) {
  return (
    <BaseSwitch.Root
      data-slot="switch"
      className={cx(
        "inline-flex h-5 w-8 shrink-0 cursor-pointer items-center rounded-capsule bg-fill-hover transition-colors ease-out",
        "focus-visible:focus-ring data-checked:bg-toggle-on data-disabled:cursor-not-allowed data-disabled:opacity-switch-disabled",
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb
        data-slot="switch-thumb"
        className="block size-4 translate-x-0.5 rounded-capsule border border-foreground bg-foreground shadow-thumb transition-transform ease-out data-checked:translate-x-3.5"
      />
    </BaseSwitch.Root>
  );
}
