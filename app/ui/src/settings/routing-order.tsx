import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { useState } from "react";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { effortLabel, type ModelChoice, type ModelGroup, ModelPicker, ProviderMark } from "../components/composer/model-picker";
import { named } from "../components/composer/model-keys";
import { SelectTrigger } from "../components/select";
import { Plus, X } from "../icons";
import { DragDots } from "../icons/note";
import type { Entry, Now } from "./routing";

/** A divider drawn inside the top edge, as the old design's strokes are: it adds no height. */
const HAIRLINE_TOP = "relative before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-divider";
/** Add model's picker before its first pick: nothing checked. */
const NOTHING: ModelChoice = { provider: "", model: "", effort: null };

const keyOf = (entry: Entry) => `${entry.agent}/${entry.model}`;
const asEntry = (choice: ModelChoice): Entry => ({ agent: choice.provider, model: choice.model, effort: choice.effort });

/** My order: each model dragged by its grip (or ↑ ↓), its model and effort in the shared picker [D19], its quota or why it can't run, Remove; then Add model. */
export function OrderList({ title, order, states, groups, onSave }: { title: string; order: Entry[]; states?: Now[string]["entries"]; groups: ModelGroup[]; onSave: (order: Entry[]) => void }) {
  // What Add model has added while it is open: another pick there changes it, not adds one more.
  const [added, setAdded] = useState<string | null>(null);
  const addedEntry = order.find((entry) => keyOf(entry) === added) ?? null;
  // A place keeps its id as its model changes, so the picker open on it stays open.
  const [placeOf, setPlaceOf] = useState<Readonly<Record<string, string>>>({});
  const ids = order.map((entry) => placeOf[keyOf(entry)] ?? keyOf(entry));
  const move = (id: string, to: number) => {
    const moved = order[ids.indexOf(id)];
    if (!moved) return;
    const rest = order.filter((entry) => entry !== moved);
    rest.splice(to, 0, moved);
    onSave(rest);
  };
  const add = (choice: ModelChoice) => {
    const next = asEntry(choice);
    const taken = order.some((entry) => keyOf(entry) === keyOf(next) && entry !== addedEntry);
    if (taken) return;
    setAdded(keyOf(next));
    onSave(addedEntry ? order.map((entry) => (entry === addedEntry ? next : entry)) : [...order, next]);
  };
  return (
    <div data-slot="my-order" className="flex flex-col ps-7.5 pb-1">
      <div className={cx(HAIRLINE_TOP, "flex flex-col pt-1 pb-2")}>
        <DragDropProvider
          onDragEnd={({ operation, canceled }) => {
            const { source } = operation;
            if (!canceled && isSortable(source) && source.index !== source.initialIndex) move(String(source.id), source.index);
          }}
        >
          <ol aria-label={`The order ${title} tries`} className="flex flex-col">
            {order.map((entry, index) => (
              <OrderPlace
                key={ids[index]}
                id={ids[index]!}
                entry={entry}
                state={states?.[keyOf(entry)]}
                index={index}
                count={order.length}
                groups={groups}
                onMove={(to) => move(ids[index]!, to)}
                onChange={(next) => {
                  // A model already in the order isn't taken twice.
                  if (order.some((other) => other !== entry && keyOf(other) === keyOf(next))) return;
                  setPlaceOf((places) => ({ ...places, [keyOf(next)]: ids[index]! }));
                  onSave(order.map((other) => (other === entry ? next : other)));
                }}
                onRemove={() => onSave(order.filter((other) => other !== entry))}
              />
            ))}
          </ol>
        </DragDropProvider>
        <ModelPicker
          groups={groups}
          value={addedEntry ? { provider: addedEntry.agent, model: addedEntry.model, effort: addedEntry.effort } : NOTHING}
          onChange={add}
          asksSwitch={false}
          onClose={() => setAdded(null)}
          trigger={(props) => (
            <Button {...props} variant="link-blue" size="inline" className="h-9 w-fit gap-2 ps-6.5 text-xs font-medium">
              <Plus aria-hidden className="size-3.5" />
              Add model
            </Button>
          )}
        />
      </div>
    </div>
  );
}

/** One model of your order: grip and place, the picker of its model and effort, and Remove. */
function OrderPlace({
  id,
  entry,
  state,
  index,
  count,
  groups,
  onMove,
  onChange,
  onRemove,
}: {
  id: string;
  entry: Entry;
  state?: Now[string]["entries"][string];
  index: number;
  count: number;
  groups: ModelGroup[];
  onMove: (to: number) => void;
  onChange: (next: Entry) => void;
  onRemove: () => void;
}) {
  const { ref, handleRef, isDragging } = useSortable({ id, index, disabled: count < 2 });
  const name = named(groups, entry.agent, entry.model);
  const mark = groups.find((group) => group.provider === entry.agent)?.mark ?? null;
  return (
    <li ref={ref} data-slot="ranked-place" className={cx("flex h-11 items-center gap-3 rounded-control", isDragging && "bg-fill-hover")}>
      <button
        ref={handleRef}
        type="button"
        aria-label={`Move ${name} (${index + 1} of ${count}); drag, or press up and down`}
        title="Drag to reorder, or focus and press ↑ ↓"
        disabled={count < 2}
        onKeyDown={(event) => {
          const to = index + (event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0);
          if (isDragging || to === index || to < 0 || to >= count) return;
          event.preventDefault();
          onMove(to);
          // Moving the row takes focus from it; give it back so ↑ ↓ keep going.
          const grip = event.currentTarget;
          requestAnimationFrame(() => grip.focus());
        }}
        className="flex h-full cursor-grab touch-none items-center gap-3 text-muted-foreground active:cursor-grabbing disabled:cursor-default"
      >
        <DragDots className="h-3.5 w-2.5" />
        <span className="w-2 font-mono text-xs">{index + 1}</span>
      </button>
      <span className={cx("min-w-0 flex-1", state?.off && "opacity-disabled")}>
        <ModelPicker
          groups={groups}
          value={{ provider: entry.agent, model: entry.model, effort: entry.effort }}
          onChange={(choice) => onChange(asEntry(choice))}
          asksSwitch={false}
          trigger={(props) => (
            <SelectTrigger {...props} label={`${name}: model and effort`} data-slot="order-place-model" icon={<ProviderMark mark={mark} className="size-3.5" />} className="w-auto">
              {name}
              <span className="text-muted-foreground"> · {entry.effort ? effortLabel(entry.effort) : "Default"}</span>
            </SelectTrigger>
          )}
        />
      </span>
      {state?.text && <span className="shrink-0 text-xs text-muted-foreground">{state.text}</span>}
      <TooltipIconButton tooltip="Remove" aria-label={`Remove ${name}`} onClick={onRemove} className="shrink-0 text-muted-foreground">
        <X />
      </TooltipIconButton>
    </li>
  );
}
