import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { type ComponentProps, useCallback } from "react";

import { X } from "../icons";
import { Button } from "./button";
import { cx } from "./cx";

export const Dialog = BaseDialog.Root;
export function DialogTrigger(props: BaseDialog.Trigger.Props) {
  return <BaseDialog.Trigger data-dialog-trigger {...props} />;
}
export const DialogClose = BaseDialog.Close;

/**
 * Keeps an open dialog's top edge where it first opened, centred in its area (the window, or `area`). A
 * centred card whose content changes after it opens (a preview that arrives, a line that loads) moves
 * both edges at once, a jump; held by its top it only grows or shrinks downward. It moves up only as far
 * as it must to stay in view, and centres again when the window resizes. The edge goes in `data-top`,
 * which theme.css's `dialog-top` reads.
 */
function usePinnedTop(area: HTMLElement | null | undefined) {
  return useCallback(
    (card: HTMLDivElement | null) => {
      if (!card) return;
      const margin = () => parseFloat(getComputedStyle(card).scrollMarginTop) || 0;
      const room = () => (area ?? document.documentElement).clientHeight - card.offsetHeight - margin();
      let top = 0;
      const place = () => {
        card.dataset.top = String(Math.max(margin(), Math.min(top, room())));
      };
      const centre = () => {
        top = Math.round(Math.max(margin(), (room() + margin()) / 2));
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

type DialogContentProps = Omit<BaseDialog.Popup.Props, "className"> & {
  className?: string;
  /** A close button in the top corner. */
  showCloseButton?: boolean;
  /** Where the dialog is placed and centred; the window by default. */
  container?: HTMLElement | null;
  /** Its width, padding and gap, for a card laid out its own way (cx doesn't merge a caller's). */
  frame?: string;
  /** Where its top edge sits (a `top-*` class) instead of centred, for a card that grows as results come (a palette). */
  top?: string;
};

/** A centred see-through card over the dimmed page. */
export function DialogContent({ className, children, showCloseButton = true, container, frame = "max-w-dialog gap-4 p-5", top, ...props }: DialogContentProps) {
  const pin = usePinnedTop(container);
  return (
    <BaseDialog.Portal container={container}>
      <BaseDialog.Backdrop
        data-slot="dialog-overlay"
        className="fixed inset-0 isolate z-popup bg-dialog-backdrop backdrop-motion"
      />
      <BaseDialog.Popup
        ref={top ? undefined : pin}
        data-slot="dialog-content"
        className={cx(
          "fixed start-1/2 z-popup grid w-full -translate-x-1/2 bg-material text-sm text-foreground shadow-material dialog-card",
          frame,
          top ?? "dialog-top",
          "outline-none backdrop-blur-material dialog-motion rtl:translate-x-1/2",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <BaseDialog.Close
            data-slot="dialog-close"
            aria-label="Close"
            className={cx(
              "absolute end-4 top-4 cursor-pointer rounded-xs opacity-dialog-close transition-all hover:opacity-100 focus-visible:focus-ring",
              "disabled:cursor-not-allowed motion-safe:active:scale-press svg:pointer-events-none svg:shrink-0 svg:size-icon-md",
            )}
          >
            <X />
          </BaseDialog.Close>
        )}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cx("flex flex-col gap-2", className)} {...props} />;
}

export function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: ComponentProps<"div"> & { showCloseButton?: boolean }) {
  return (
    <div data-slot="dialog-footer" className={cx("flex flex-row justify-end gap-2", className)} {...props}>
      {children}
      {showCloseButton && <BaseDialog.Close render={<Button variant="outline" />}>Close</BaseDialog.Close>}
    </div>
  );
}

export function DialogTitle({ className, ...props }: Omit<BaseDialog.Title.Props, "className"> & { className?: string }) {
  return <BaseDialog.Title data-slot="dialog-title" className={cx("font-display text-base leading-none font-medium", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: Omit<BaseDialog.Description.Props, "className"> & { className?: string }) {
  return <BaseDialog.Description data-slot="dialog-description" className={cx("text-sm text-muted-foreground", className)} {...props} />;
}
