import { Toast } from "@base-ui/react/toast";

import { CheckCircle, InfoCircle, Warning, X } from "../icons";
import { cx } from "./cx";

/** How long a toast stays when nobody hovers or focuses it. */
const DURATION_MS = 4000;

type Tone = "neutral" | "success" | "error";
type ToastAction = { label: string; run: () => void };

/** The app's toasts, shown by the Toaster; `showToast` adds one from anywhere. */
export const toastManager = Toast.createToastManager();

/** Shows a short message ("Changes reverted", "Archived chat"), with buttons for what can follow it. */
export function showToast(text: string, { tone = "neutral", actions = [] }: { tone?: Tone; actions?: ToastAction[] } = {}) {
  return toastManager.add({ title: text, type: tone, data: { actions } });
}

const ICONS = { success: CheckCircle, error: Warning, neutral: InfoCircle };

function ToastList() {
  const { toasts, close } = Toast.useToastManager();
  return toasts.map((toast) => {
    const tone = (toast.type ?? "neutral") as Tone;
    const Icon = ICONS[tone];
    const actions: ToastAction[] = toast.data?.actions ?? [];
    return (
      <Toast.Root
        key={toast.id}
        toast={toast}
        swipeDirection="up"
        data-slot="toast"
        className={cx(
          // A capsule for one line; a long error wraps inside the same rounded box.
          "flex min-h-control-md max-w-toast items-center gap-2 rounded-tooltip border bg-popover py-1 ps-3 pe-1.5 text-sm",
          "toast-motion motion-reduce:transition-none",
          tone === "success" && "border-success-border text-success",
          tone === "error" && "border-destructive-border text-destructive",
          tone === "neutral" && "border-border text-foreground",
        )}
      >
        <Icon aria-hidden className={cx("size-icon-sm shrink-0", tone === "neutral" && "text-muted-foreground")} />
        <Toast.Title className="min-w-0" />
        {actions.map((action) => (
          <Toast.Action
            key={action.label}
            onClick={() => {
              action.run();
              close(toast.id);
            }}
            className="ms-1 cursor-pointer font-medium text-foreground transition-colors hover:text-action-hover focus-visible:focus-ring"
          >
            {action.label}
          </Toast.Action>
        ))}
        <Toast.Close
          aria-label="Dismiss"
          className={cx(
            "flex size-control-xs shrink-0 cursor-pointer items-center justify-center rounded-capsule opacity-toast-close transition-all",
            "hover:bg-fill-hover hover:opacity-100 focus-visible:focus-ring motion-safe:active:scale-press",
          )}
        >
          <X className="size-icon-xs" />
        </Toast.Close>
      </Toast.Root>
    );
  });
}

/**
 * Where toasts show, stacked and centred: put it in the pane they belong to (the conversation's, just
 * under its header) and place it with `className`.
 */
export function Toaster({ className, manager = toastManager }: { className?: string; manager?: typeof toastManager }) {
  return (
    // No limit: the old stack showed every toast, and Base UI makes the ones over its limit inert.
    <Toast.Provider toastManager={manager} timeout={DURATION_MS} limit={Infinity}>
      <Toast.Viewport
        className={cx(
          "pointer-events-none absolute inset-x-0 z-popup flex flex-col items-center gap-2 outline-none *:pointer-events-auto",
          className,
        )}
      >
        <ToastList />
      </Toast.Viewport>
    </Toast.Provider>
  );
}
