// The confirm dialog as a macOS alert, as Apple might draw it (D40): an approximation, gallery-only.
import type { ReactNode, Ref } from "react";

import { cx } from "../../src/components/cx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, pushButton } from "./dialog";
import { Spinner, spin } from "./spinner";

type ConfirmFormProps = {
  title: ReactNode;
  description: ReactNode;
  /** More lines under the description. */
  children?: ReactNode;
  /** The confirm button's words ("Delete", "Stage"). */
  confirm: ReactNode;
  /** A red confirm, for what can't be undone. */
  destructive?: boolean;
  /** While it works: a spinner on the confirm, both buttons off, and the dialog stays. */
  busy?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** The confirm button, to focus it on open. */
  confirmRef?: Ref<HTMLButtonElement>;
};

/**
 * A macOS alert: the app's icon, a bold title and a small line, centred, then Cancel on the leading side
 * and the action on the trailing side, the action blue (or red words when it can't be undone).
 */
export function ConfirmForm({
  title,
  description,
  children,
  confirm,
  destructive = false,
  busy = false,
  disabled = false,
  onConfirm,
  onCancel,
  confirmRef,
}: ConfirmFormProps) {
  return (
    <div data-slot="apple-alert" className="flex flex-col items-center gap-3 text-center">
      {/* Where the app's icon goes; our own mark waits. */}
      <span aria-hidden className="size-12 rounded-apple-tile bg-fill-active" />
      <DialogHeader className="items-center">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      {children}
      <div className="mt-1 grid w-full grid-cols-2 gap-2">
        <button type="button" className={pushButton()} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          ref={confirmRef}
          className={pushButton(destructive ? "destructive" : "default")}
          disabled={busy || disabled}
          onClick={onConfirm}
        >
          {busy && <Spinner className={cx("size-icon-xs", spin)} />}
          {confirm}
        </button>
      </div>
    </div>
  );
}

/**
 * Asks before an action: a title, one line, Cancel and the action (red when it can't be undone). With no
 * `title` the box is empty, as while it closes after what it asked about went.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  container,
  ...form
}: Omit<ConfirmFormProps, "onCancel" | "title"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode | null;
  /** Where the dialog is placed; the window by default. */
  container?: HTMLElement | null;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !form.busy && onOpenChange(next)}>
      <DialogContent container={container}>
        {title !== null && <ConfirmForm title={title} onCancel={() => onOpenChange(false)} {...form} />}
      </DialogContent>
    </Dialog>
  );
}
