// macOS has no toast: this is its closest pattern, a notification banner, as Apple might draw it (D40).
// An approximation, gallery-only.
import { Toast } from "@base-ui/react/toast";

import { cx } from "../../src/components/cx";
import { CheckCircle, InfoCircle, Warning, X } from "../../src/icons";

const DURATION_MS = 4000;

type Tone = "neutral" | "success" | "error";
type ToastAction = { label: string; run: () => void };

export const toastManager = Toast.createToastManager();

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
        swipeDirection="right"
        data-slot="toast"
        className={cx(
          "group relative flex w-full max-w-apple-banner items-center gap-3 rounded-apple-banner bg-apple-material p-3 text-label",
          "shadow-apple-material backdrop-blur-material toast-motion motion-reduce:transition-none",
        )}
      >
        {/* The app's icon goes here; a banner shows the tone by its icon, not by colour. */}
        <span className="flex size-control-lg shrink-0 items-center justify-center rounded-apple-tile bg-fill-active">
          <Icon
            aria-hidden
            className={cx(
              "size-icon-lg",
              tone === "success" && "text-success",
              tone === "error" && "text-destructive",
              tone === "neutral" && "text-muted-foreground",
            )}
          />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-semibold">Brigadier</span>
          <Toast.Title className="text-foreground" />
        </div>
        {actions.map((action) => (
          <Toast.Action
            key={action.label}
            onClick={() => {
              action.run();
              close(toast.id);
            }}
            className={cx(
              "h-control-xs shrink-0 cursor-default rounded-capsule bg-apple-button px-3 font-medium transition-colors",
              "hover:bg-apple-button-hover focus-visible:outline-3 focus-visible:outline-solid focus-visible:outline-apple-focus",
            )}
          >
            {action.label}
          </Toast.Action>
        ))}
        {/* Shown on hover, at the leading top corner, as macOS does. */}
        <Toast.Close
          aria-label="Dismiss"
          className={cx(
            "absolute -start-1.5 -top-1.5 flex size-control-xs cursor-default items-center justify-center rounded-capsule bg-apple-material",
            "opacity-0 shadow-apple-material backdrop-blur-material transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
            "focus-visible:outline-3 focus-visible:outline-solid focus-visible:outline-apple-focus",
          )}
        >
          <X className="size-icon-xs" />
        </Toast.Close>
      </Toast.Root>
    );
  });
}

/** Banners stack at the top trailing corner of their area. */
export function Toaster({ className, manager = toastManager }: { className?: string; manager?: typeof toastManager }) {
  return (
    <Toast.Provider toastManager={manager} timeout={DURATION_MS} limit={Infinity}>
      <Toast.Viewport
        className={cx(
          "pointer-events-none absolute inset-x-0 z-popup flex flex-col items-end gap-2 outline-none *:pointer-events-auto",
          className,
        )}
      >
        <ToastList />
      </Toast.Viewport>
    </Toast.Provider>
  );
}
