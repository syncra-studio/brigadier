import { Radio as BaseRadio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";

import { cx } from "./cx";

/** One choice of several; arrow keys move it. */
export function RadioGroup(props: BaseRadioGroup.Props) {
  return <BaseRadioGroup data-slot="radio-group" {...props} />;
}

/** A small round mark that fills with the switch's blue around a white dot when chosen. */
export function Radio({ className, ...props }: Omit<BaseRadio.Root.Props, "className"> & { className?: string }) {
  return (
    <BaseRadio.Root
      data-slot="radio"
      className={cx(
        "flex size-icon-md shrink-0 cursor-pointer items-center justify-center rounded-capsule border border-input focus-visible:focus-ring",
        "data-checked:border-toggle-on data-checked:bg-toggle-on data-disabled:cursor-not-allowed data-disabled:opacity-disabled",
        className,
      )}
      {...props}
    >
      <BaseRadio.Indicator className="size-1.5 rounded-capsule bg-foreground" />
    </BaseRadio.Root>
  );
}
