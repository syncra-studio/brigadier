// Pins on a variant's frame, the old Mockup tab's Marker, NoteBox and Surface: pointing is always on [D2055], so the
// pointer shows a ghost pin, a click drops a numbered one with its "Add a comment…" pill, and a pin opens to edit.
import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { ArrowUp, Trash } from "../icons";
import { markerNumber, type MockupNote, notePlacement, type Pointed, pointIn, tokenPx } from "./notes";

/** A press that moves less than this is a click (it drops a pin), not a drag. */
const CLICK_SLOP = 8;

/** What the pointer is over on a live frame: its box, as fractions of the frame, and what it is. */
export type Hovered = { x: number; y: number; width: number; height: number; element: Pointed };

/** A place on the frame, for `mockup-at`. */
const at = (point: { x: number; y: number }) => ({ "data-x": point.x, "data-y": point.y });

/** "SidebarRow · Sidebar.tsx:42": what a pin points at, as its outline and the tray name it. */
export const pointedName = (element: Pointed) => (element.file ? `${element.name} · ${element.file}` : element.name);

/**
 * The pins of a frame and, while pointing, the layer that takes its clicks: `notes` are the round's, numbered through
 * every variant; `sent` ones, of an older round, only show.
 */
export function PinLayer({
  variant,
  notes,
  pointing,
  hovered,
  onNotes,
}: {
  variant: string;
  notes: readonly MockupNote[];
  pointing: boolean;
  hovered?: Hovered | null;
  onNotes?: (change: (pins: MockupNote[]) => MockupNote[]) => void;
}) {
  const own = notes.filter((note) => note.variant === variant);
  const [draft, setDraft] = useState<{ x: number; y: number; element: Pointed | null } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const down = useRef<{ x: number; y: number } | null>(null);
  const active = pointing && Boolean(onNotes);
  if (!active && (draft || editing)) {
    setDraft(null);
    setEditing(null);
  }
  const local = (event: ReactPointerEvent) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width !== size.width || box.height !== size.height) setSize({ width: box.width, height: box.height });
    return { x: event.clientX - box.left, y: event.clientY - box.top, width: box.width, height: box.height };
  };
  return (
    <div
      data-slot="mockup-pins"
      className={cx("absolute inset-0", active ? "cursor-none" : "pointer-events-none")}
      onPointerMove={active ? (event) => { const point = local(event); setHover(pointIn(point, point)); } : undefined}
      onPointerLeave={() => setHover(null)}
      onPointerDown={active ? (event) => { down.current = local(event); } : undefined}
      onPointerUp={
        active
          ? (event) => {
              const start = down.current;
              down.current = null;
              if (!start || event.target !== event.currentTarget) return;
              const end = local(event);
              if (Math.hypot(end.x - start.x, end.y - start.y) > CLICK_SLOP) return;
              setEditing(null);
              // What the pointer was over when it dropped the pin goes with it.
              setDraft({ ...pointIn(end, end), element: hovered?.element ?? null });
            }
          : undefined
      }
    >
      {active && hovered && (
        <>
          <span className="mockup-at mockup-box pointer-events-none absolute rounded-xs outline-2 outline-mockup-pin" {...at(hovered)} data-w={hovered.width} data-h={hovered.height} />
          <span className="mockup-at pointer-events-none absolute -translate-y-full rounded-xs bg-mockup-pin px-1 font-mono text-2xs whitespace-nowrap text-foreground" {...at(hovered)}>
            {pointedName(hovered.element)}
          </span>
        </>
      )}
      {own.map((note) => (
        <Marker
          key={note.id}
          at={note}
          number={markerNumber(notes, note)}
          label={`Edit comment ${markerNumber(notes, note)}`}
          selected={editing === note.id}
          onClick={active ? () => { setDraft(null); setEditing(note.id); } : undefined}
        />
      ))}
      {draft && <Marker at={draft} number={notes.length + 1} label="New comment" selected />}
      {active && hover && !draft && !editing && <Marker at={hover} label="" ghost />}
      {draft && onNotes && (
        <NoteBox
          at={draft}
          surface={size}
          onCancel={() => setDraft(null)}
          onSave={(text) => {
            onNotes((pins) => [...pins, { id: crypto.randomUUID(), variant, ...draft, text }]);
            setDraft(null);
          }}
        />
      )}
      {editing && onNotes && (() => {
        const note = own.find((entry) => entry.id === editing);
        return (
          note && (
            <NoteBox
              key={note.id}
              at={note}
              surface={size}
              initial={note.text}
              onCancel={() => setEditing(null)}
              onDelete={() => { onNotes((pins) => pins.filter((entry) => entry.id !== note.id)); setEditing(null); }}
              onSave={(text) => { onNotes((pins) => pins.map((entry) => (entry.id === note.id ? { ...entry, text } : entry))); setEditing(null); }}
            />
          )
        );
      })()}
    </div>
  );
}

/** A note's pin: a numbered drop pointing at its place on the frame. */
export function Marker({
  at: point,
  number,
  label,
  selected = false,
  ghost = false,
  small = false,
  onClick,
}: {
  at?: { x: number; y: number };
  number?: number;
  label: string;
  selected?: boolean;
  ghost?: boolean;
  /** The tray's: in line with its note, not placed. */
  small?: boolean;
  onClick?: (() => void) | undefined;
}) {
  const className = cx(
    "flex shrink-0 items-center justify-center rounded-mockup-pin bg-mockup-pin font-bold leading-none text-foreground shadow-mockup-pin",
    small ? "size-4 text-2xs" : "mockup-at absolute size-mockup-marker -translate-x-1/2 -translate-y-1/2 text-2xs transition-transform duration-150 ease-enter motion-reduce:transition-none",
    selected && "scale-105",
    ghost && "pointer-events-none opacity-70",
    onClick && "cursor-pointer hover:scale-105",
  );
  const place = point ? at(point) : undefined;
  if (ghost) return <span aria-hidden className={className} {...place} />;
  return onClick ? (
    <button type="button" aria-label={label} className={className} {...place} onPointerUp={(event) => event.stopPropagation()} onClick={onClick}>
      {number}
    </button>
  ) : (
    <span aria-label={label} className={className} {...place}>
      {number}
    </span>
  );
}

/**
 * The note box beside a pin: a one-line "Add a comment…" pill for a new note (Enter adds it, Escape drops it), or a
 * card to edit or delete a saved one (⌘↩ saves).
 */
function NoteBox({
  at: point,
  surface,
  initial,
  onSave,
  onCancel,
  onDelete,
}: {
  at: { x: number; y: number };
  surface: { width: number; height: number };
  initial?: string;
  onSave: (text: string) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [text, setText] = useState(initial ?? "");
  const editing = initial !== undefined;
  const box = { width: tokenPx("--spacing-mockup-note"), height: tokenPx(editing ? "--spacing-mockup-note-edit" : "--spacing-mockup-note-input") };
  const gap = tokenPx("--spacing-mockup-marker") / 2 + tokenPx("--spacing-mockup-marker-gap");
  const place = notePlacement({ x: point.x * surface.width, y: point.y * surface.height }, box, surface, gap, tokenPx("--spacing") * 2);
  const placed = { "data-left": place.left, "data-top": place.top };
  const save = () => {
    if (text.trim()) onSave(text.trim());
  };
  const stop = { onPointerUp: (event: ReactPointerEvent) => event.stopPropagation(), onPointerDown: (event: ReactPointerEvent) => event.stopPropagation() };
  if (!editing) {
    return (
      <form
        {...stop}
        data-slot="mockup-note"
        {...placed}
        onSubmit={(event) => { event.preventDefault(); save(); }}
        className="note-at absolute z-10 flex h-mockup-note-input w-mockup-note cursor-auto items-center gap-2 rounded-capsule bg-popover py-2 ps-4 pe-2 shadow-mockup-control"
      >
        <input
          autoFocus
          aria-label="Comment"
          placeholder="Add a comment…"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onCancel(); } }}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {text.trim() && (
          <button type="submit" aria-label="Add comment" className="flex size-icon-button-sm shrink-0 items-center justify-center rounded-capsule bg-foreground text-background">
            <ArrowUp className="size-icon-sm" />
          </button>
        )}
      </form>
    );
  }
  return (
    <div {...stop} data-slot="mockup-note" {...placed} className="note-at absolute z-10 flex h-mockup-note-edit w-mockup-note cursor-auto flex-col overflow-hidden rounded-xl bg-popover shadow-mockup-control">
      <textarea
        autoFocus
        aria-label="Comment"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); save(); }
          if (event.key === "Escape") { event.preventDefault(); onCancel(); }
        }}
        className="min-h-0 flex-1 resize-none bg-transparent px-4 pt-3 text-sm outline-none"
      />
      <div className="flex shrink-0 items-center gap-1.5 py-2 ps-2 pe-3">
        <Button variant="ghost" size="icon-sm" aria-label="Delete comment" onClick={onDelete}>
          <Trash />
        </Button>
        <div className="flex-1" />
        <Button variant="outline" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" disabled={!text.trim()} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
