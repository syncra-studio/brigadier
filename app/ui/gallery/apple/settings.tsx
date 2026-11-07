// Gallery only (D66): Settings card, row and row text as macOS System Settings' grouped forms draw them,
// for the owner to compare. Deleted after the pick.
import type { ComponentProps, ReactNode } from "react";

import { cx } from "../../src/components/cx";
import { ErrorLine } from "../../src/components/error-line";

/** A grouped form's box: an inset rounded fill, rows split by hairlines 10 in. */
export function SettingsCard({
  padded = false,
  className,
  ...props
}: ComponentProps<"div"> & { padded?: boolean }) {
  return (
    <div
      {...props}
      className={cx(
        "flex flex-col rounded-apple-group bg-apple-group shadow-apple-group",
        padded ? "gap-2 px-2.5 py-2" : "apple-form-rows",
        className,
      )}
    />
  );
}

/** One form row: label over its secondary line at the start, the control at the end. */
export function SettingsRow({
  label,
  description,
  htmlFor,
  error,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  error?: string | null;
  children?: ReactNode;
}) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 px-2.5 py-1.75">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Label htmlFor={htmlFor} className="text-label break-words">
          {label}
        </Label>
        {description && <div className="text-2xs break-words text-apple-secondary">{description}</div>}
        <ErrorLine error={error} />
      </div>
      {children && <div className="flex shrink-0 items-center justify-end gap-1.5">{children}</div>}
    </div>
  );
}

/** A row's words: the title in the label's weight, a secondary line under it. */
export function RowText({ title, line, quiet = false }: { title: ReactNode; line?: ReactNode; quiet?: boolean }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className={cx("text-label", quiet && "text-apple-secondary")}>{title}</span>
      {line && <span className="text-2xs text-apple-secondary">{line}</span>}
    </span>
  );
}
