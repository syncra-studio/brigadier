// A candidate (D48): the confirm dialog in the Apple alert's structure, made of the kit's own parts.
// Gallery-only until the owner picks; then it replaces confirm-dialog.tsx's form.
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { type ReactNode, useCallback } from "react";

import { Button } from "../src/components/button";
import { DialogDescription, DialogTitle } from "../src/components/dialog";
import { Spinner } from "../src/icons";

// The kit's dialog.tsx: holds the card's top edge where it opened, centred in its area.
function usePinnedTop(area: HTMLElement | null | undefined) {
  return useCallback(
    (card: HTMLDivElement | null) => {
      if (!card) return;
      const room = () => (area ?? document.documentElement).clientHeight - card.offsetHeight;
      let top = 0;
      const place = () => {
        card.dataset.top = String(Math.max(0, Math.min(top, room())));
      };
      const centre = () => {
        top = Math.round(Math.max(0, room() / 2));
        place();
      };
      centre();
      const observer = new ResizeObserver(place);
      observer.observe(card);
      addEventListener("resize", centre);
      return () => {
        observer.disconnect();
        removeEventListener("resize", centre);
      };
    },
    [area],
  );
}

type Props = {
  title: ReactNode;
  description: ReactNode;
  confirm: ReactNode;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Where the card is placed and centred; the window by default. */
  container?: HTMLElement | null;
  /** Off for a frozen copy, which mustn't take the focus. */
  initialFocus?: false;
};

/**
 * A narrow centred card: the app's icon, the title and its line centred under it, then Cancel and the
 * action side by side, equal width, the action on the trailing side. The kit's card, type and buttons.
 */
export function AlertConfirm({ title, description, confirm, destructive = false, busy = false, onConfirm, onCancel, container, initialFocus }: Props) {
  const pin = usePinnedTop(container);
  return (
    <BaseDialog.Portal container={container}>
      <BaseDialog.Backdrop className="fixed inset-0 isolate z-popup bg-dialog-backdrop backdrop-motion" />
      <BaseDialog.Popup
        ref={pin}
        initialFocus={initialFocus}
        className="fixed start-1/2 z-popup flex w-full max-w-apple-alert -translate-x-1/2 flex-col items-center gap-3 bg-material p-4 text-center text-sm text-foreground shadow-material outline-none backdrop-blur-material dialog-card dialog-top dialog-motion rtl:translate-x-1/2"
      >
        {/* Where the app's icon goes; our own mark waits. */}
        <span aria-hidden className="size-12 rounded-apple-tile bg-fill-active" />
        <div className="flex flex-col gap-2">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </div>
        {/* Marks the card as a confirm's, for its rounder corners. */}
        <div data-confirm className="mt-1 grid w-full grid-cols-2 gap-2">
          <Button size="sm" variant="outline" className="w-full" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant={destructive ? "destructive" : "default"} className="w-full" disabled={busy} onClick={onConfirm}>
            {busy && <Spinner className="size-icon-xs animate-spin motion-reduce:animate-none" />}
            {confirm}
          </Button>
        </div>
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}
