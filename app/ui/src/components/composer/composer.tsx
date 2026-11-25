import { Button as BaseButton } from "@base-ui/react/button";
import { type ComponentProps, type MouseEvent, type ReactNode, useRef, useState } from "react";

import { Plus } from "../../icons";
import { Button } from "../button";
import { cx } from "../cx";
import { TooltipIconButton, type TooltipIconButtonProps } from "../icon-button";
import { Kbd } from "../kbd";
import { type Draft, isEmpty } from "./draft";
import { ComposerField, type ComposerFieldHandle } from "./field";
import { ComposerRail } from "./rail";

/**
 * The column, the thread's rows and the composer alike, so their edges line up: 736 of text inside 16 each side,
 * centred (box-content, so the reading width is the text's) [D84].
 */
export const COLUMN = "mx-auto box-content max-w-reading px-4";

/**
 * The composer's column under the thread (below its scroller, not over it): the thread's column, its card's edges on
 * the thread's text edges [D208], its bottom as far up the page's panel as the panel is in the frame
 * [D55 D823]. What sits above the card (the rail, a decision) stacks in it too.
 */
export function Composer({ className, ...props }: ComponentProps<"div">) {
  // A block in a full-width box inside the thread's scrollbar gutters, as the thread's rows are, so its box-content column
  // fills the same width theirs does.
  // Raised over the thread's bottom fade and jump button: the reading column's translate (summary-column) makes the
  // column a layer of its own, which would draw its `@` and `/` menus under them [D332].
  return (
    <div className="w-full shrink-0 px-scrollbar pb-3">
      <div data-slot="composer" className={cx(COLUMN, "relative z-20 flex flex-col", className)} {...props} />
    </div>
  );
}

/** A click in the card's empty space puts the cursor in its field, as a click in the text would. */
function focusField(event: MouseEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement;
  if (target !== event.currentTarget && target.dataset["slot"] !== "composer-footer") return;
  event.preventDefault();
  event.currentTarget.querySelector<HTMLElement>("[contenteditable]")?.focus();
}

/** The card: the field over its footer. */
function ComposerCard({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-card"
      onMouseDown={focusField}
      className={cx("relative flex w-full cursor-text flex-col gap-1 rounded-composer bg-composer p-2 shadow-composer", className)}
      {...props}
    />
  );
}

/** The card's bottom row: tools on the left (`ComposerTools`), then a picker and Send. */
export function ComposerFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="composer-footer" className={cx("flex items-center gap-1", className)} {...props} />;
}

export function ComposerTools({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("flex min-w-0 flex-1 flex-wrap items-center gap-0.5", className)} {...props} />;
}

/** The + button that opens the add menu (Files and more). */
export function PlusButton(props: Omit<TooltipIconButtonProps, "tooltip" | "size" | "children">) {
  return (
    // A white + [D207].
    <TooltipIconButton tooltip="Add files and more" look="bar" {...props}>
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
        "transition-all hover:bg-fill aria-expanded:bg-fill focus-visible:focus-ring motion-safe:active:scale-press-button",
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
 * The one composer Home and a session mount [D2108]: the rail over the card, the card's tiles over
 * its field (`children`), and the footer in the old app's order: + and the permission pill side by side, then
 * `status`, the model and Send [D2106, D2111]. `above` (an approval) takes the card's place
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
  model,
  send,
  after,
  shell,
  look,
  children,
  ...card
}: Pick<ComponentProps<"div">, "onDragOver" | "onDrop" | "children"> & Partial<Record<"rail" | "above" | "tiles" | "plus" | "level" | "status" | "model" | "send" | "after", ReactNode>> & { hidden?: boolean; /** A shell command is typed: nothing attached, no permission or model pick. */ shell?: boolean; /** A class the whole composer wears, but as a shell command. */ look?: string }) {
  return (
    <Composer className={shell ? undefined : look}>
      <ComposerRail>{rail}</ComposerRail>
      {above}
      <ComposerCard className={cx(hidden && "hidden", shell && "ring-1 ring-link")} {...card} {...(shell && { onDragOver: undefined, onDrop: undefined })}>
        {tiles}
        {children}
        <ComposerFooter>
          <ComposerTools>
            {shell ? (
              <span className="flex h-control-sm min-w-0 items-center gap-2 px-2 text-sm">
                <span className="truncate text-link">Shell command</span>
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <Kbd>Esc</Kbd> to exit
                </span>
              </span>
            ) : (
              <>
                {plus}
                {level}
              </>
            )}
          </ComposerTools>
          {status}
          {!shell && model}
          {send}
        </ComposerFooter>
      </ComposerCard>
      {after}
    </Composer>
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
