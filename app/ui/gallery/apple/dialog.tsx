// The dialog as a macOS sheet, as Apple might draw it (D40): an approximation, gallery-only.
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { type ComponentProps, useCallback } from "react";

import { cx } from "../../src/components/cx";

export const Dialog = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;

/** A macOS push button: a capsule, plain, the blue default, or red words for what can't be undone. */
export function pushButton(kind: "plain" | "default" | "destructive" = "plain") {
  return cx(
    "inline-flex h-control-sm min-w-20 cursor-default items-center justify-center gap-1.5 rounded-capsule px-4 text-label font-medium",
    "outline-none transition-colors focus-visible:outline-3 focus-visible:outline-solid focus-visible:outline-apple-focus disabled:opacity-disabled",
    kind === "default" ? "bg-apple-accent text-apple-on-accent hover:bg-apple-accent-hover" : "bg-apple-button hover:bg-apple-button-hover",
    kind === "plain" && "text-foreground",
    kind === "destructive" && "text-destructive",
  );
}

// The kit's: keeps an open dialog's top edge where it first opened, centred in its area.
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

type DialogContentProps = Omit<BaseDialog.Popup.Props, "className"> & {
  className?: string;
  /** macOS sheets have no close button in the corner: kept for the kit's shape, unused. */
  showCloseButton?: boolean;
  container?: HTMLElement | null;
};

/** A rounded card of see-through material over the dimmed window; with an alert inside, an alert. */
export function DialogContent({ className, children, showCloseButton: _close, container, ...props }: DialogContentProps) {
  const pin = usePinnedTop(container);
  return (
    <BaseDialog.Portal container={container}>
      <BaseDialog.Backdrop data-slot="dialog-overlay" className="fixed inset-0 isolate z-popup bg-dialog-backdrop backdrop-motion" />
      <BaseDialog.Popup
        ref={pin}
        data-slot="dialog-content"
        className={cx(
          "fixed start-1/2 z-popup grid w-full -translate-x-1/2 gap-4 rounded-sheet bg-material p-5 text-label text-foreground",
          "shadow-material outline-none backdrop-blur-material apple-dialog dialog-top dialog-motion rtl:translate-x-1/2",
          className,
        )}
        {...props}
      >
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cx("flex flex-col gap-1", className)} {...props} />;
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
      {showCloseButton && <BaseDialog.Close className={pushButton("default")}>Close</BaseDialog.Close>}
    </div>
  );
}

export function DialogTitle({ className, ...props }: Omit<BaseDialog.Title.Props, "className"> & { className?: string }) {
  return <BaseDialog.Title data-slot="dialog-title" className={cx("text-label font-semibold", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: Omit<BaseDialog.Description.Props, "className"> & { className?: string }) {
  return <BaseDialog.Description data-slot="dialog-description" className={cx("text-2xs text-muted-foreground", className)} {...props} />;
}
