import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";

import { Check, Minus } from "../icons";
import { cx } from "./cx";

const BOX = "flex size-icon-md shrink-0 items-center justify-center rounded-checkbox border border-input";
const FILLED = "border-toggle-on bg-toggle-on text-foreground";

/** The one checkbox: fills with the switch's blue and shows a white tick, or a dash when `indeterminate`. */
export function Checkbox({ className, ...props }: Omit<BaseCheckbox.Root.Props, "className"> & { className?: string }) {
  return (
    <BaseCheckbox.Root
      data-slot="checkbox"
      className={cx(
        BOX,
        "cursor-pointer focus-visible:focus-ring data-disabled:cursor-not-allowed",
        "data-checked:border-toggle-on data-checked:bg-toggle-on data-checked:text-foreground",
        "data-indeterminate:border-toggle-on data-indeterminate:bg-toggle-on data-indeterminate:text-foreground",
        className,
      )}
      {...props}
    >
      <BaseCheckbox.Indicator>
        {props.indeterminate ? <Minus className="size-icon-xs" /> : <Check className="size-icon-xs" />}
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
}

/** The checkbox's look alone, for a control that is a whole card (the card is the checkbox). */
export function CheckboxMark({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span aria-hidden data-slot="checkbox-mark" className={cx(BOX, checked && FILLED, className)}>
      {checked && <Check className="size-icon-xs" />}
    </span>
  );
}
