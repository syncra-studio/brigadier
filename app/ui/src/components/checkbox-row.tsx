import { type ReactNode, useId } from "react";

import { Checkbox } from "./checkbox";
import { cx } from "./cx";

/** A checkbox with its label; `note` explains why it is disabled. */
export function CheckboxRow({
  label,
  note,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  note?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className={cx("flex items-start gap-2.5", disabled && "opacity-row-disabled")}>
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} className="mt-0.5" />
      <label htmlFor={id} className={cx("grid gap-0.5", disabled ? "cursor-not-allowed" : "cursor-pointer")}>
        <span className="text-label leading-4">{label}</span>
        {note && <span className="text-xs leading-3.75 text-quiet-foreground">{note}</span>}
      </label>
    </div>
  );
}
