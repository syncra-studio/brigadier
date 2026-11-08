import type { ReactNode, Ref } from "react";

import { Spinner } from "../icons";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog";

type ConfirmFormProps = {
  title: ReactNode;
  description: ReactNode;
  /** More lines under the description. */
  children?: ReactNode;
  /** The other button's words; "Cancel" by default. */
  cancel?: ReactNode;
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

/** A confirm's inside: its title and line, then Cancel and the action. */
export function ConfirmForm({
  title,
  description,
  children,
  cancel = "Cancel",
  confirm,
  destructive = false,
  busy = false,
  disabled = false,
  onConfirm,
  onCancel,
  confirmRef,
}: ConfirmFormProps) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      {children}
      {/* Marks the card as a confirm's, for its rounder corners. */}
      <DialogFooter data-confirm>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {cancel}
        </Button>
        <Button ref={confirmRef} variant={destructive ? "destructive" : "default"} disabled={busy || disabled} onClick={onConfirm}>
          {busy && <Spinner className="size-icon-xs animate-spin motion-reduce:animate-none" />}
          {confirm}
        </Button>
      </DialogFooter>
    </>
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
