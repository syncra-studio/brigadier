import { Button as BaseButton } from "@base-ui/react/button";

import { ArrowCurvedRight, DotsHorizontal, EditPencil, Hamburger, Play, QueueGlyph, Spinner, Trash } from "../../icons";
import { Button } from "../button";
import { cx } from "../cx";
import { ErrorLine } from "../error-line";
import { TooltipIconButton } from "../icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../menu";
import type { Draft } from "./draft";
import { useQueueDrag } from "./queue-drag";
import { RailItem } from "./rail";

/**
 * A message waiting for the running turn, as Rust holds it. PROPOSED to the owning runs. `local`: just sent,
 * not yet confirmed (its actions wait); `deciding`: the session is judging whether it joins the work in
 * progress; `delivered`: the session has it, so it can't be pulled back to edit.
 */
export type QueuedMessage = { id: string; draft: Draft; state: "local" | "queued" | "deciding" | "delivered" };

/** The row's words: the text with each mention's name in place. */
function preview(draft: Draft): string {
  return draft.parts
    .map((part) => (typeof part === "string" ? part : part.kind === "mention" ? part.label : ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : `${count} ${many}`);

/** What rides with the text: "Image attachment", "Pasted text", "3 images", "2 files"… or nothing. */
function attached(draft: Draft): string | null {
  const chips = draft.parts.filter((part) => typeof part !== "string" && part.kind !== "mention");
  const images = chips.filter((chip) => typeof chip !== "string" && chip.kind === "image").length;
  const total = chips.length + draft.attachmentIds.length;
  if (total === 0) return null;
  if (images === total) return plural(total, "Image attachment", "images");
  if (total === 1 && chips.length === 1) return "Pasted text";
  return plural(total, "1 file", "files");
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
  onResume: () => void;
  onSteer: (id: string) => void;
  onRemove: (id: string) => void;
  onEdit: (id: string) => void;
  onMove: (id: string, to: number) => void;
}) {
  const { listRef, shown, grip } = useQueueDrag(items, onMove);
  if (items.length === 0) return null;
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
      <ol ref={listRef} aria-label="Queued messages" className="flex max-h-queue-max flex-col overflow-y-auto p-1">
        {shown.map((item, index) => {
          const local = item.state === "local";
          const deciding = item.state === "deciding";
          const text = preview(item.draft);
          const files = attached(item.draft);
          const draggable = items.length > 1 && !local;
          const glyph = cx("size-icon-sm", draggable && "group-hover/queue-item:invisible group-focus-within/queue-item:invisible");
          return (
            <li
              key={item.id}
              data-slot="queue-item"
              aria-busy={deciding || undefined}
              className="group/queue-item flex min-h-control-md items-center gap-2 rounded-control ps-1.5 pe-1 text-sm queue-shift data-grabbed:bg-fill-hover motion-safe:animate-fade-in"
            >
              <span className="relative flex size-control-xs shrink-0 items-center justify-center text-queue-glyph">
                {deciding ? <Spinner className={cx(glyph, "animate-spin motion-reduce:animate-none")} /> : <QueueGlyph className={glyph} />}
                {draggable && (
                  <span className="invisible absolute inset-0 flex group-hover/queue-item:visible group-focus-within/queue-item:visible">
                    <BaseButton
                      aria-label="Drag to reorder"
                      title="Drag to reorder"
                      className="flex size-full cursor-grab touch-none items-center justify-center rounded-control transition-all hover:bg-fill hover:text-foreground focus-visible:focus-ring active:cursor-grabbing"
                      {...grip(item.id, index)}
                    >
                      <Hamburger className="size-icon-sm" />
                    </BaseButton>
                  </span>
                )}
              </span>
              {/* The message comes first: short of room, the note after it gives way. */}
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
        })}
      </ol>
      <ErrorLine error={error} className="px-3 pb-1" />
    </RailItem>
  );
}
