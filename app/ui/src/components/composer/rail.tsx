import { type ComponentProps, createContext, type Key, type KeyboardEvent, type ReactNode, useContext, useRef, useState } from "react";

import { ChevronRight, ExclamationMarkCircle, Info, QuestionMarkCircle, Warning, X } from "../../icons";
import { Button } from "../button";
import { ConfirmForm } from "../confirm-dialog";
import { cx } from "../cx";
import { Dialog, DialogContent } from "../dialog";
import { ErrorLine } from "../error-line";
import { TooltipIconButton } from "../icon-button";

/**
 * How long after the rail appears its items are simply there rather than opening: a session's view is drawn
 * anew on each switch, and the cards it already has belong to it, not to the moment.
 */
const SETTLE_MS = 400;

/** When the rail appeared (`performance.now()`); null outside one. */
const RailShown = createContext<number | null>(null);

/**
 * The composer rail: a strip on the card's top edge, inset from its sides and tucked under it, so only its
 * top corners show. It holds notices, the queue, a held message and decisions; hidden while it holds nothing.
 * Placed right above `ComposerCard`, which draws over the tuck.
 */
export function ComposerRail({ className, ...props }: ComponentProps<"div">) {
  const [shown] = useState(() => performance.now());
  return (
    <RailShown value={shown}>
      <div
        data-slot="composer-rail"
        className={cx("relative mx-rail-inset -mb-rail-tuck flex flex-col overflow-clip rounded-t-overlay empty:hidden", className)}
        {...props}
      />
    </RailShown>
  );
}

/**
 * One item of the rail. `card` is a framed card (notices, the queue); `controls` a darker tab with no frame;
 * `decision` a card waiting for the user, which at the rail's bottom shows its whole frame a small gap above
 * the card instead of tucking under it. Items open to their height as they come, except those the rail had
 * as it appeared and those that came while the window was hidden.
 */
export function RailItem({
  variant = "card",
  label,
  className,
  children,
}: {
  variant?: "controls" | "card" | "decision";
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const railShown = useContext(RailShown);
  const [opens] = useState(
    () => document.visibilityState === "visible" && (railShown === null || performance.now() - railShown > SETTLE_MS),
  );
  return (
    <section
      data-slot="composer-rail-item"
      data-variant={variant}
      aria-label={label}
      className={cx(
        "grid grid-rows-1 first:rounded-t-overlay",
        opens && "motion-safe:animate-rail-open",
        // The tuck under the card is padding, so the last item's content never hides behind it.
        variant !== "decision" && "last:pb-rail-tuck",
        variant === "controls" ? "bg-code-surface" : "border-x border-t border-border bg-rail-glass",
        variant === "decision" && "last:mb-rail-clear last:rounded-b-overlay last:border-b",
        className,
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </section>
  );
}

/** The notices card: one `NoticeRow` each, newest last. */
export function Notices({ children }: { children: ReactNode }) {
  return (
    <RailItem label="Notices">
      <ul className="flex flex-col divide-y divide-border">{children}</ul>
    </RailItem>
  );
}

const ICON = "mt-0.5 size-icon-sm shrink-0";
const NOTICE_ICONS = {
  info: <Info className={cx(ICON, "text-muted-foreground")} />,
  warning: <Warning className={cx(ICON, "text-warning")} />,
  error: <ExclamationMarkCircle className={cx(ICON, "text-destructive")} />,
};

/**
 * What the user must act on, or what stopped the turn (D64: notices live here, never in a banner): a tinted
 * icon, the words, its action (Retry) and ✕. An error's words are the kit's one error line (D87).
 */
export function NoticeRow({
  level,
  action,
  pager,
  onDismiss,
  children,
}: {
  level: keyof typeof NOTICE_ICONS;
  action?: ReactNode;
  /** ‹ 2 of 3 ›, between the action and ✕. */
  pager?: ReactNode;
  onDismiss?: () => void;
  children: string;
}) {
  return (
    <li data-level={level} className="flex items-start gap-2.5 py-2 ps-3.5 pe-2.5 text-label text-foreground">
      {NOTICE_ICONS[level]}
      {level === "error" ? (
        <ErrorLine error={children} className="min-w-0 flex-1" />
      ) : (
        <span className="min-w-0 flex-1 whitespace-pre-wrap">
          {children}
        </span>
      )}
      {action}
      {pager}
      {onDismiss ? (
        <TooltipIconButton tooltip="Dismiss notice" size="icon-xs" className="text-muted-foreground" onClick={onDismiss}>
          <X />
        </TooltipIconButton>
      ) : (
        // Holds ✕'s place, so the pager stays put while paging past a notice that can't be dismissed.
        pager && <span aria-hidden className="size-5 shrink-0" />
      )}
    </li>
  );
}

/** A notice; one with an `action` (Retry) has that instead of ✕, as in the old app. */
type Notice = { id: Key; level: keyof typeof NOTICE_ICONS; text: string; action?: ReactNode };

/**
 * The notices one at a time, newest first (owner's D114, D119), with ‹ "2 of 3" › before ✕ while there are more
 * (←/→ while it has focus, wrapping at the ends). ✕ dismisses only the one on screen, and the next takes its place.
 */
export function PagedNotices({ notices, onDismiss }: { notices: readonly Notice[]; onDismiss: (id: Key) => void }) {
  const order = notices.toReversed();
  const [at, setAt] = useState<{ id?: Key; index: number }>({ index: 0 });
  if (order.length === 0) return null;
  // The one on screen, found by id; once it's gone, whichever took its place.
  const found = order.findIndex((notice) => notice.id === at.id);
  const index = found >= 0 ? found : at.index % order.length;
  const notice = order[index]!;
  const go = (step: number) => {
    const next = (index + step + order.length) % order.length;
    setAt({ id: order[next]!.id, index: next });
  };
  const keys = (event: KeyboardEvent) => {
    const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (!step) return;
    event.preventDefault();
    go(step);
  };
  const pager = order.length > 1 && (
    <div role="group" aria-label={`Notice ${index + 1} of ${order.length}`} onKeyDown={keys} className="flex shrink-0 items-center">
      <TooltipIconButton tooltip="Previous notice" size="icon-xs" className="text-muted-foreground" onClick={() => go(-1)}>
        <ChevronRight className="rotate-180" />
      </TooltipIconButton>
      <span aria-hidden className="px-0.5 text-xs text-muted-foreground tabular-nums">
        {index + 1} of {order.length}
      </span>
      <TooltipIconButton tooltip="Next notice" size="icon-xs" className="text-muted-foreground" onClick={() => go(1)}>
        <ChevronRight />
      </TooltipIconButton>
    </div>
  );
  return (
    <RailItem label="Notices">
      <ul aria-live="polite" className="flex flex-col">
        <NoticeRow
          key={notice.id}
          level={notice.level}
          action={notice.action}
          pager={pager}
          onDismiss={
            notice.action
              ? undefined
              : () => {
                  setAt({ index });
                  onDismiss(notice.id);
                }
          }
        >
          {notice.text}
        </NoticeRow>
      </ul>
    </RailItem>
  );
}

/** A quiet rail row: muted words, then its buttons. */
function RailRow({ children }: { children: ReactNode }) {
  return <div className="flex min-h-control-md items-center gap-2 px-3 text-sm text-muted-foreground">{children}</div>;
}

/** A message that couldn't go, kept whole: Restore puts it back into the empty field, Discard lets it go. */
export function HeldRow({ reason, onRestore, onDiscard }: { reason: string; onRestore: () => void; onDiscard: () => void }) {
  return (
    <RailItem label="Message not sent">
      <RailRow>
        <span className="min-w-0 flex-1 truncate">Not sent · {reason}</span>
        <Button size="xs" variant="ghost" onClick={onRestore}>
          Restore
        </Button>
        <Button size="xs" variant="ghost" onClick={onDiscard}>
          Discard
        </Button>
      </RailRow>
    </RailItem>
  );
}

/** What a decision put aside with ✕ leaves on the rail, so it stays one click away. */
export function WaitingRow({ count, onShow }: { count: number; onShow: () => void }) {
  return (
    <RailItem label="Waiting for you">
      <RailRow>
        <QuestionMarkCircle className="size-icon-sm shrink-0" />
        <span className="min-w-0 flex-1 truncate">{count === 1 ? "A decision waits for you" : `${count} decisions wait for you`}</span>
        <Button size="xs" variant="ghost" onClick={onShow}>
          Show
        </Button>
      </RailRow>
    </RailItem>
  );
}

/**
 * "Send message?", asked when sending while the queue is paused with messages in it: Send now goes ahead of
 * them, Keep paused puts it in the queue with them. Closing sends nothing and the draft stays; the field gets
 * the keyboard back.
 */
export function PausedSendDialog({
  waiting,
  onSendNow,
  onKeepPaused,
  onClose,
  held,
}: {
  /** How many wait in the paused queue; null while closed. */
  waiting: number | null;
  onSendNow: () => void;
  onKeepPaused: () => void;
  onClose: () => void;
  /** The gallery's box to hold it open in, not modal and not taking focus. */
  held?: HTMLElement;
}) {
  const sendNow = useRef<HTMLButtonElement>(null);
  // Kept while the dialog animates out.
  const [count, setCount] = useState(waiting ?? 0);
  if (waiting !== null && waiting !== count) setCount(waiting);
  return (
    <Dialog open={waiting !== null} onOpenChange={(open) => !open && onClose()} modal={!held}>
      <DialogContent container={held} initialFocus={held ? false : sendNow}>
        <ConfirmForm
          title="Send message?"
          description={`The queue is paused. ${count === 1 ? "One message waits" : `${count} messages wait`} until you resume it. Send this one now, or keep it in the queue with them.`}
          cancel="Keep paused"
          confirm="Send now"
          onCancel={onKeepPaused}
          onConfirm={onSendNow}
          confirmRef={sendNow}
        />
      </DialogContent>
    </Dialog>
  );
}
