import { Input as BaseInput } from "@base-ui/react/input";

import { cx } from "./cx";

/** Fills its container's width: size it by its container (cx doesn't merge a caller's width). */
export function Input({ className, ...props }: Omit<BaseInput.Props, "className"> & { className?: string }) {
  return (
    <BaseInput
      data-slot="input"
      className={cx(
        "h-control-md w-full min-w-0 rounded-capsule border border-transparent bg-fill px-3.5 py-1 text-sm transition-colors",
        "placeholder:text-muted-foreground focus-visible:bg-background focus-visible:focus-ring",
        "cursor-text disabled:cursor-not-allowed disabled:bg-input-disabled disabled:opacity-disabled",
        "aria-invalid:border-invalid aria-invalid:ring aria-invalid:ring-invalid-ring",
        className,
      )}
      {...props}
    />
  );
}
