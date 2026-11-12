import { Button as BaseButton } from "@base-ui/react/button";
import { type ComponentProps, type MouseEvent, type ReactNode, useRef, useState } from "react";

import { Plus } from "../../icons";
import { Button } from "../button";
import { cx } from "../cx";
import { TooltipIconButton, type TooltipIconButtonProps } from "../icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import { type Draft, isEmpty } from "./draft";
import { ComposerField, type ComposerFieldHandle } from "./field";
import { ComposerRail } from "./rail";

/**
 * The composer's column under the thread (below its scroller, not over it): the reading width, 16px from
 * the window's bottom. What sits above the card (the rail, a decision) stacks in it too.
 */
export function Composer({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="composer" className={cx("mx-auto flex w-full max-w-reading shrink-0 flex-col px-4 pb-4", className)} {...props} />;
}

/** A click in the card's empty space puts the cursor in its field, as a click in the text would. */
function focusField(event: MouseEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement;
  if (target !== event.currentTarget && target.dataset["slot"] !== "composer-footer") return;
  event.preventDefault();
  event.currentTarget.querySelector<HTMLElement>("[contenteditable]")?.focus();
}

/** The card: the field over its footer. */
export function ComposerCard({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-card"
      onMouseDown={focusField}
      className={cx("relative flex w-full cursor-text flex-col gap-1 rounded-composer bg-composer p-2 shadow-hairline", className)}
      {...props}
    />
  );
}

/** The card's bottom row: tools on the left (`ComposerTools`), then the context ring, a picker and Send. */
export function ComposerFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="composer-footer" className={cx("flex items-center gap-1", className)} {...props} />;
}

export function ComposerTools({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("flex min-w-0 flex-1 flex-wrap items-center gap-0.5", className)} {...props} />;
}

/** The + button that opens the add menu (Files and more). */
export function PlusButton(props: Omit<TooltipIconButtonProps, "tooltip" | "size" | "children">) {
  return (
    <TooltipIconButton tooltip="Add files and more" size="icon-md" {...props}>
      <Plus />
    </TooltipIconButton>
  );
}

/** A picker's trigger or a chip in the footer: muted words and an icon on a capsule that fills on hover or open. */
export function ComposerPill({ className, ...props }: Omit<BaseButton.Props, "className"> & { className?: string }) {
  return (
    <BaseButton
      type="button"
      className={cx(
        "inline-flex h-control-sm min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-capsule px-2 text-sm text-muted-foreground",
        "transition-all hover:bg-fill aria-expanded:bg-fill aria-pressed:bg-fill focus-visible:focus-ring motion-safe:active:scale-press-button",
        "disabled:cursor-not-allowed disabled:opacity-disabled svg:size-icon-md svg:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

/** The hairline between the footer's pills. */
export function PillDivider() {
  return <span aria-hidden className="mx-1 h-icon-md w-px shrink-0 bg-input" />;
}

/**
 * The one composer the gallery, Home and a session mount [D2108]: the rail over the card, the card's tiles over
 * its field (`children`), and the footer in the old app's order: + and the permission pill side by side, then
 * `status`, the context ring, the model and Send [D2106, D2111]. `above` (an approval) takes the card's place
 * while `hidden`; `after` holds its dialogs.
 */
export function SharedComposer({
  rail,
  above,
  hidden,
  tiles,
  plus,
  level,
  status,
  ring,
  model,
  send,
  after,
  children,
  ...card
}: Pick<ComponentProps<"div">, "onDragOver" | "onDrop" | "children"> & Partial<Record<"rail" | "above" | "tiles" | "plus" | "level" | "status" | "ring" | "model" | "send" | "after", ReactNode>> & { hidden?: boolean }) {
  return (
    <Composer>
      <ComposerRail>{rail}</ComposerRail>
      {above}
      <ComposerCard className={hidden ? "hidden" : undefined} {...card}>
        {tiles}
        {children}
        <ComposerFooter>
          <ComposerTools>
            {plus}
            {level}
          </ComposerTools>
          {status}
          {ring}
          {model}
          {send}
        </ComposerFooter>
      </ComposerCard>
      {after}
    </Composer>
  );
}

/** "45k": tokens in thousands. */
const thousands = (tokens: number) => `${Math.round(tokens / 1000)}k`;

/**
 * How full the model's context is: a thin ring whose arc is the share used (no number, no colour change),
 * and on hover "Context window:", "17% used (83% left)", "45k / 258k tokens used". With no known window,
 * only the tokens.
 */
export function ContextRing({ usedTokens, windowTokens }: { usedTokens: number; windowTokens: number | null }) {
  const share = windowTokens ? Math.min(1, Math.max(0, usedTokens / windowTokens)) : null;
  const percent = share === null ? null : Math.round(share * 100);
  return (
    <Tooltip>
      <TooltipTrigger
        delay={0}
        render={
          <span
            role="img"
            aria-label={percent === null ? `Context usage: ${thousands(usedTokens)} tokens` : `Context usage: ${percent}%`}
            className="flex size-control-sm shrink-0 items-center justify-center"
          />
        }
      >
        <svg viewBox="0 0 16 16" aria-hidden className="size-icon-md -rotate-90">
          <circle cx="8" cy="8" r="7" fill="none" className="stroke-input stroke-2" />
          {share !== null && share > 0 && (
            <circle cx="8" cy="8" r="7" fill="none" pathLength={100} strokeDasharray={`${share * 100} 100`} strokeLinecap="round" className="stroke-muted-foreground stroke-2" />
          )}
        </svg>
      </TooltipTrigger>
      <TooltipContent side="top">
        <span className="flex flex-col gap-0.5 py-0.75">
          <span className="text-muted-foreground">Context window:</span>
          {percent !== null && windowTokens ? (
            <>
              <span>
                {percent}% used ({100 - percent}% left)
              </span>
              <span>
                {thousands(usedTokens)} / {thousands(windowTokens)} tokens used
              </span>
            </>
          ) : (
            <span>{thousands(usedTokens)} tokens used</span>
          )}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Editing a sent message in the thread, to send it again: the composer's field in a composer-coloured card,
 * Cancel and Send under it. Enter sends, Esc cancels.
 */
export function EditComposer({ initial, onCancel, onSend }: { initial: Draft; onCancel: () => void; onSend: (parts: Draft["parts"]) => void }) {
  const field = useRef<ComposerFieldHandle>(null);
  const [empty, setEmpty] = useState(isEmpty(initial));
  const send = () => {
    const parts = field.current!.parts();
    if (!isEmpty({ parts, attachmentIds: initial.attachmentIds })) onSend(parts);
  };
  return (
    <div className="flex flex-col px-2">
      <div className="ms-auto flex w-full flex-col gap-2 rounded-composer bg-composer p-2">
        <ComposerField
          ref={field}
          initial={initial}
          placeholder=""
          label="Edit message"
          size="edit"
          autoFocus
          onChange={(parts) => setEmpty(isEmpty({ parts, attachmentIds: initial.attachmentIds }))}
          onSubmit={send}
          onEscape={onCancel}
        />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" className="border border-border" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={empty} onClick={send}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
