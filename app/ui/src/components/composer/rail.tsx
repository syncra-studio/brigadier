import { type ComponentProps, createContext, type Key, type KeyboardEvent, type ReactNode, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

import { ChevronDown, ChevronRight, ExclamationMarkCircle, Info, QuestionMarkCircle, Warning, X } from "../../icons";
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
 * top corners show. It holds notices, the queue and decisions; hidden while it holds nothing.
 * Placed right above `ComposerCard`, which draws over the tuck.
 */
export function ComposerRail({ className, ...props }: ComponentProps<"div">) {
  const [shown] = useState(() => performance.now());
  return (
    <RailShown value={shown}>
      <div
        data-slot="composer-rail"
        className={cx("relative mx-rail-inset -mb-rail-tuck flex flex-col overflow-clip rounded-t-overlay empty:hidden menu-over:hidden", className)}
        {...props}
      />
    </RailShown>
  );
}

/**
 * One item of the rail, each on the project strip's fill [D480] and framed, so the frame runs unbroken down a rail of
 * several [D684]. `card` holds notices, the queue and the project strip; `decision` a card waiting for the user, which at
 * the rail's bottom shows its whole frame a small gap above the card instead of tucking under it. Items open to their
 * height as they come, except those the rail had as it appeared and those that came while the window was hidden.
 * One turned not `shown` folds back to nothing first.
 */
export function RailItem({
  variant = "card",
  label,
  shown = true,
  className,
  children,
}: {
  variant?: "card" | "decision";
  label: string;
  shown?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const railShown = useContext(RailShown);
  const [opens, setOpens] = useState(
    () => document.visibilityState === "visible" && (railShown === null || performance.now() - railShown > SETTLE_MS),
  );
  const [present, setPresent] = useState(shown);
  if (shown && !present) {
    setPresent(true);
    setOpens(true);
  }
  // Without motion there is no fold to wait for.
  useEffect(() => {
    if (shown || !present || !matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setPresent(false);
  }, [shown]);
  if (!present) return null;
  return (
    <section
      data-slot="composer-rail-item"
      data-variant={variant}
      aria-label={label}
      onAnimationEnd={(event) => {
        if (shown || event.target !== event.currentTarget) return;
        setPresent(false);
      }}
      className={cx(
        "grid grid-rows-1 first:rounded-t-overlay",
        !shown ? "motion-safe:animate-rail-close" : opens && "motion-safe:animate-rail-open",
        // The tuck under the card is padding, so the last item's content never hides behind it.
        variant !== "decision" && "last:pb-rail-tuck",
        // Every strip has the project strip's fill [D480].
        "bg-code-surface border-x border-t border-border",
        variant === "decision" && "last:mb-rail-clear last:rounded-b-overlay last:border-b",
        className,
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </section>
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
 * icon, the words, its action (Retry) and ✕. An error's words are the kit's one error line (D87). Words past
 * one line are cut with an ellipsis, and the chevron after them opens the whole text in place (D122).
 */
export function NoticeRow({
  level,
  action,
  pager,
  onDismiss,
  subject,
  children,
}: {
  level: keyof typeof NOTICE_ICONS;
  /** What the words are about, before them: a session's chip. */
  subject?: ReactNode;
  action?: ReactNode;
  /** ‹ 2 of 3 ›, between the action and ✕. */
  pager?: ReactNode;
  onDismiss?: () => void;
  children: string;
}) {
  const [open, setOpen] = useState(false);
  // Another notice in its place starts folded.
  const [text, setText] = useState(children);
  if (text !== children) {
    setText(children);
    setOpen(false);
  }
  const [long, setLong] = useState(false);
  const fold = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const words = fold.current?.firstElementChild;
    if (!words || open) return;
    const measure = () => setLong(words.scrollHeight > words.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(words);
    return () => observer.disconnect();
  }, [open, children]);
  const clamp = "line-clamp-1 group-data-open/notice:line-clamp-none";
  return (
    <li data-level={level} className="flex items-start gap-2.5 py-2 ps-3.5 pe-2.5 text-label text-foreground">
      {NOTICE_ICONS[level]}
      <div ref={fold} data-open={open || undefined} className={cx("group/notice min-w-0 flex-1 notice-fold", level === "error" && "text-xs")}>
        {level === "error" ? (
          <ErrorLine error={children} className={clamp} />
        ) : (
          <p className={cx(clamp, "whitespace-pre-wrap")}>
            {subject && <>{subject} </>}
            {children}
          </p>
        )}
      </div>
      {(long || open) && (
        <TooltipIconButton
          tooltip={open ? "Show less" : "Show the whole notice"}
          size="icon-xs"
          aria-expanded={open}
          className="text-muted-foreground"
          onClick={() => setOpen(!open)}
        >
          <ChevronDown className={cx("chevron-motion", open && "rotate-180")} />
        </TooltipIconButton>
      )}
      {action}
      {pager}
      {onDismiss && (
        <TooltipIconButton tooltip="Dismiss notice" size="icon-xs" className="text-muted-foreground" onClick={onDismiss}>
          <X />
        </TooltipIconButton>
      )}
    </li>
  );
}

/** A notice; `action` (Retry) comes before the pager and ✕. */
export type Notice = { id: Key; level: keyof typeof NOTICE_ICONS; text: string; action?: ReactNode };

/**
 * The notices one at a time, newest first (owner's D114, D119), with ‹ "2 of 3" › before ✕ while there are more
 * (←/→ while it has focus, wrapping at the ends). ✕ dismisses only the one on screen, and the next takes its place.
 */
export function Notices({ notices, onDismiss }: { notices: readonly Notice[]; onDismiss: (id: Key) => void }) {
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
        {/* Not keyed by notice: the pager stays mounted, so focus stays on it while paging. */}
        <NoticeRow
          level={notice.level}
          action={notice.action}
          pager={pager}
          onDismiss={() => {
            setAt({ index });
            onDismiss(notice.id);
          }}
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
}: {
  /** How many wait in the paused queue; null while closed. */
  waiting: number | null;
  onSendNow: () => void;
  onKeepPaused: () => void;
  onClose: () => void;
}) {
  const sendNow = useRef<HTMLButtonElement>(null);
  // Kept while the dialog animates out.
  const [count, setCount] = useState(waiting ?? 0);
  if (waiting !== null && waiting !== count) setCount(waiting);
  return (
    <Dialog open={waiting !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent initialFocus={sendNow}>
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
