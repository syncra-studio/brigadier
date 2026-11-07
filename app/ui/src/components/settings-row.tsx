import type { ReactNode } from "react";

import { cx } from "./cx";
import { ErrorLine } from "./error-line";

/**
 * One setting: its label and description at the start, its control at the end. `htmlFor` ties the label
 * to a control with that id; without it, give the control its own label. `error` is what the last change
 * failed with.
 */
export function SettingsRow({
  label,
  description,
  htmlFor,
  error,
  children,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  error?: string | null;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="settings-row" className={cx("@container flex items-center justify-between gap-6 px-4 py-3", className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-label font-medium break-words">
            {label}
          </label>
        ) : (
          <div className="text-label font-medium break-words">{label}</div>
        )}
        {description && <div className="text-xs break-words text-quiet-foreground">{description}</div>}
        <ErrorLine error={error} />
      </div>
      {children && <div className="flex max-w-full min-w-settings-control shrink-0 items-center justify-end gap-2">{children}</div>}
    </div>
  );
}
