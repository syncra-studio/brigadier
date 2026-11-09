import { Button as BaseButton } from "@base-ui/react/button";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { useState } from "react";

import { ArrowCurvedRight, ChevronUpDown, DotsHorizontal, EditPencil, Info, Play, QueueGlyph, Spinner, Trash } from "../../icons";
import { Button } from "../button";
import { cx } from "../cx";
import { ErrorLine } from "../error-line";
import { TooltipIconButton } from "../icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import type { Draft } from "./draft";
import { RailItem } from "./rail";

/**
 * A message waiting for the running turn, as Rust holds it. PROPOSED to the owning runs. `local`: just sent,
 * not yet confirmed (its actions wait); `deciding`: the session is judging whether it joins the work in
 * progress; `delivered`: the session has it, so it can't be pulled back to edit.
 */
export type QueuedMessage = { id: string; draft: Draft; state: "local" | "queued" | "deciding" | "delivered" };

type HeldMessage = { draft: Draft; reason: string; onRestore: () => void; onDiscard: () => void };

/** The row's words: the text with each mention's and command's name in place. */
function preview(draft: Draft): string {
  return draft.parts
    .map((part) => (typeof part === "string" ? part : part.kind === "mention" || part.kind === "command" ? part.label : ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : `${count} ${many}`);

/** What rides with the text: "Image attachment", "Pasted text", "3 images", "2 files"… or nothing. */
function attached(draft: Draft): string | null {
  const chips = draft.parts.filter((part) => typeof part !== "string" && (part.kind === "image" || part.kind === "paste"));
  const images = chips.filter((chip) => typeof chip !== "string" && chip.kind === "image").length;
  const total = chips.length + draft.attachmentIds.length;
  if (total === 0) return null;
  if (images === total) return plural(total, "Image attachment", "images");
  if (total === 1 && chips.length === 1) return "Pasted text";
  return plural(total, "1 file", "files");
}

/** The list with one item moved to `to`. */
function moved<T extends { id: string }>(items: readonly T[], id: string, to: number): T[] {
  const rest = items.filter((each) => each.id !== id);
  const item = items.find((each) => each.id === id);
  if (item) rest.splice(to, 0, item);
  return rest;
}

/**
 * The queue card on the rail: what waits for the running turn, one row each in sending order (glyph, text,
 * Steer, Delete, ⋯), dragged by the grip that takes the glyph's place on hover. After an interrupt it pauses
 * until resumed. Every action goes to Rust; the row shows it at once and settles by id.
 */
export function QueueCard({
  items,
  paused = false,
  resuming = false,
  steer = false,
  canEdit,
  error,
  notSent,
  onResume,
  onSteer,
  onRemove,
  onEdit,
  onMove,
}: {
  items: readonly QueuedMessage[];
  paused?: boolean;
  /** Resume was asked and hasn't settled: its button waits. */
  resuming?: boolean;
  /** The agent can steer a running turn (offers Steer). */
  steer?: boolean;
  /** Edit message pulls a message back into the field, so only into an empty one. */
  canEdit: boolean;
  /** An action that failed. */
  error?: string | null;
  /** A message that couldn't go, kept whole: a row at the end of the list. */
  notSent?: HeldMessage | null;
  onResume: () => void;
  onSteer: (id: string) => void;
  onRemove: (id: string) => void;
  onEdit: (id: string) => void;
  /** Moves it to `to` in the new order; settles when Rust has it. */
  onMove: (id: string, to: number) => Promise<unknown> | void;
}) {
  // The order the user made, held by id until every move has settled, so Rust's order never undoes one in flight.
  const [held, setHeld] = useState<{ order: readonly string[]; moving: number } | null>(null);
  const rank = new Map(held?.order.map((id, at) => [id, at]));
  const shown = held ? items.toSorted((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)) : items;
  const move = (id: string, to: number) => {
    setHeld((now) => ({ order: moved(shown, id, to).map((each) => each.id), moving: (now?.moving ?? 0) + 1 }));
    void Promise.resolve(onMove(id, to))
      .catch(() => {}) // the failure comes back as `error`
      .finally(() => setHeld((now) => (now && now.moving > 1 ? { ...now, moving: now.moving - 1 } : null)));
  };
  if (items.length === 0 && !notSent) return null;
  return (
    <RailItem label="Message queue">
      {paused && (
        <div className="flex min-h-control-md items-center gap-2 px-3 text-sm text-muted-foreground">
          <span className="size-2 shrink-0 rounded-capsule bg-warning" />
          <span className="min-w-0 flex-1 truncate">Queue paused because you interrupted</span>
          <Button size="xs" variant="ghost" disabled={resuming} onClick={onResume}>
            <Play />
            Resume
          </Button>
        </div>
      )}
      <DragDropProvider
        onDragEnd={({ operation, canceled }) => {
          const { source } = operation;
          // A press focuses the grip, which keeps it up; let it go unless the keyboard put focus there.
          const grip = document.activeElement;
          if (grip instanceof HTMLElement && grip.closest("[data-slot=queue-item]") && !grip.matches(":focus-visible")) grip.blur();
          if (!canceled && isSortable(source) && source.index !== source.initialIndex) move(String(source.id), source.index);
        }}
      >
        <ol aria-label="Queued messages" className="flex max-h-queue-max flex-col overflow-y-auto p-1">
          {shown.map((item, index) => (
            <QueueRow
              key={item.id}
              item={item}
              index={index}
              draggable={items.length > 1 && item.state !== "local"}
              last={shown.length - 1}
              steer={steer}
              canEdit={canEdit}
              onSteer={onSteer}
              onRemove={onRemove}
              onEdit={onEdit}
              onMove={move}
            />
          ))}
          {notSent && <HeldQueueRow {...notSent} />}
        </ol>
      </DragDropProvider>
      <ErrorLine error={error} className="px-3 pb-1" />
    </RailItem>
  );
}

const ROW = "group/queue-item flex min-h-control-md items-center gap-2 rounded-control ps-1.5 pe-1 text-sm";

/** The row's words, then what rides with them; with no words, only that. The message comes first: short of room, what follows gives way. */
function Words({ draft }: { draft: Draft }) {
  const text = preview(draft);
  const files = attached(draft);
  return (
    <span className="min-w-0 flex-auto truncate" title={text || undefined}>
      {text ? (
        <>
          {text}
          {files && <span className="text-muted-foreground"> · {files}</span>}
        </>
      ) : (
        <span className="text-muted-foreground">{files}</span>
      )}
    </span>
  );
}

/** A message that couldn't go, in the list it waited in: Restore puts it back into the empty field, Discard lets it go. */
function HeldQueueRow({ draft, reason, onRestore, onDiscard }: HeldMessage) {
  return (
    <li data-slot="queue-item" className={ROW}>
      <span className="flex size-control-xs shrink-0 items-center justify-center text-queue-glyph">
        <QueueGlyph className="size-icon-sm" />
      </span>
      <Words draft={draft} />
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        Not sent
        <Tooltip>
          {/* Focusable, so the tip opens from the keyboard too; it names the reason. */}
          <TooltipTrigger
            render={
              <span role="img" tabIndex={0} aria-label={reason} className="flex shrink-0 rounded-control focus-visible:focus-ring svg:size-icon-sm">
                <Info />
              </span>
            }
          />
          <TooltipContent>{reason}</TooltipContent>
        </Tooltip>
      </span>
      <TooltipIconButton tooltip="Put it back in the field" side="top" size="xs" className="text-muted-foreground" onClick={onRestore}>
        Restore
      </TooltipIconButton>
      <TooltipIconButton tooltip="Discard message" side="top" className="text-muted-foreground" onClick={onDiscard}>
        <Trash />
      </TooltipIconButton>
      {/* Where a queued row has ⋯, so Restore and the trash line up with Steer and the trash above. */}
      <span aria-hidden className="size-control-xs shrink-0" />
    </li>
  );
}

/** One queued message: glyph (the drag grip on hover), its words, Steer, Delete and ⋯. */
function QueueRow({
  item,
  index,
  draggable,
  last,
  steer,
  canEdit,
  onSteer,
  onRemove,
  onEdit,
  onMove,
}: {
  item: QueuedMessage;
  index: number;
  draggable: boolean;
  /** The last index, for ↑/↓. */
  last: number;
  steer: boolean;
  canEdit: boolean;
  onSteer: (id: string) => void;
  onRemove: (id: string) => void;
  onEdit: (id: string) => void;
  onMove: (id: string, to: number) => void;
}) {
  const local = item.state === "local";
  const deciding = item.state === "deciding";
  const { ref, handleRef, isDragging, isDropping } = useSortable({ id: item.id, index, disabled: !draggable });
  // Grabbed, the grip stays up until the drop or Esc has settled, wherever the pointer goes (D127).
  const grabbed = isDragging || isDropping;
  // It fades in once: a row moved in the DOM (a reorder) would otherwise replay it.
  const [entered, setEntered] = useState(false);
  const glyph = cx("size-icon-sm", grabbed ? "invisible" : draggable && "group-hover/queue-item:invisible group-focus-within/queue-item:invisible");
  return (
    <li
      ref={ref}
      data-slot="queue-item"
      aria-busy={deciding || undefined}
      onAnimationEnd={(event) => event.target === event.currentTarget && setEntered(true)}
      className={cx(
        ROW,
        !entered && "motion-safe:animate-fade-in",
        isDragging && "bg-fill-hover",
      )}
    >
      <span className="relative flex size-control-xs shrink-0 items-center justify-center text-queue-glyph">
        {deciding ? <Spinner className={cx(glyph, "animate-spin motion-reduce:animate-none")} /> : <QueueGlyph className={glyph} />}
        {draggable && (
          <span
            className={cx(
              "absolute inset-0 flex",
              grabbed ? "opacity-100" : "opacity-0 group-hover/queue-item:opacity-100 group-focus-within/queue-item:opacity-100",
            )}
          >
            <BaseButton
              aria-label="Drag to reorder"
              title="Drag to reorder"
              className={cx(
                "flex size-full cursor-grab touch-none items-center justify-center rounded-control transition-all hover:bg-fill hover:text-foreground focus-visible:focus-ring",
                grabbed && "bg-fill text-foreground",
              )}
              ref={handleRef}
              onKeyDown={(event) => {
                // ↑/↓ move it one step; Space starts the library's keyboard drag, which owns the arrows meanwhile.
                const to = index + (event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0);
                if (isDragging || to === index || to < 0 || to > last) return;
                event.preventDefault();
                onMove(item.id, to);
                // Moving the row takes focus from it; give it back so ↑/↓ keep going.
                const grip = event.currentTarget;
                requestAnimationFrame(() => grip.focus());
              }}
            >
              <ChevronUpDown className="size-icon-sm" />
            </BaseButton>
          </span>
        )}
      </span>
      <Words draft={item.draft} />
      {deciding && (
        <span title="The session is checking whether this belongs to the work in progress" className="shrink-0 text-xs shimmer">
          Deciding
        </span>
      )}
      {steer && (
        <TooltipIconButton
          tooltip="Submit without interrupting the model"
          side="top"
          size="xs"
          className="text-muted-foreground"
          disabled={local}
          onClick={() => onSteer(item.id)}
        >
          <ArrowCurvedRight />
          Steer
        </TooltipIconButton>
      )}
      <TooltipIconButton tooltip="Delete queued message" side="top" className="text-muted-foreground" disabled={local} onClick={() => onRemove(item.id)}>
        <Trash />
      </TooltipIconButton>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Queued message actions" className="text-muted-foreground aria-expanded:bg-fill" />}>
          <DotsHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={!canEdit || local || item.state === "delivered"} onClick={() => onEdit(item.id)}>
            <EditPencil />
            Edit message
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
