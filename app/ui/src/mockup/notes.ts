// The user's notes on a mockup, as the old app's mockupNotes.ts: a click drops a numbered pin on a variant and a note
// says what to change there; they are kept until sent together, as one message to the mockup worker [D2055].

/** What a pin points at on a live frame: the element's component and source, where the page tells them (proposed). */
export type Pointed = { name: string; file?: string | null };

/** A note at a point of one variant, as fractions of its frame's width and height. */
export type MockupNote = { id: string; variant: string; x: number; y: number; text: string; element?: Pointed | null };

/** The notes not sent yet: the pinned ones and the one for all variants (proposed, w13), and the round they're on, 1-based. */
export type Notes = { pins: MockupNote[]; all: string; round?: number };
export const NO_NOTES: Notes = { pins: [], all: "" };

/** How many notes go with a send: each pin, and the one for all variants. */
export const noteCount = (notes: Notes) => notes.pins.length + (notes.all.trim() ? 1 : 0);

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** A point in the frame's displayed box of `size`, as fractions kept inside the frame. */
export function pointIn(point: { x: number; y: number }, size: { width: number; height: number }): { x: number; y: number } {
  return { x: clamp(point.x / size.width), y: clamp(point.y / size.height) };
}

/** A note's pin number: its place among the round's notes, which run through every variant (w13). */
export const markerNumber = (notes: readonly MockupNote[], note: MockupNote) => notes.indexOf(note) + 1;

type Box = { width: number; height: number };

/**
 * Where a note's box goes beside the point it is about, inside `surface` with `margin` to spare: right of the pin
 * (`gap` from the point), else left of it, else centred below, else above.
 */
export function notePlacement(point: { x: number; y: number }, box: Box, surface: Box, gap: number, margin: number): { left: number; top: number } {
  const fitsX = (left: number) => left >= margin && left + box.width <= surface.width - margin;
  const fitsY = (top: number) => top >= margin && top + box.height <= surface.height - margin;
  const keep = (value: number, size: number, room: number) => Math.max(margin, Math.min(value, room - margin - size));
  const middle = point.y - box.height / 2;
  if (fitsX(point.x + gap)) return { left: point.x + gap, top: keep(middle, box.height, surface.height) };
  if (fitsX(point.x - gap - box.width)) return { left: point.x - gap - box.width, top: keep(middle, box.height, surface.height) };
  const left = keep(point.x - box.width / 2, box.width, surface.width);
  return fitsY(point.y + gap) ? { left, top: point.y + gap } : { left, top: keep(point.y - gap - box.height, box.height, surface.height) };
}

/** A spacing token ("--spacing-mockup-note") in pixels. */
export function tokenPx(name: string): number {
  const root = getComputedStyle(document.documentElement);
  return parseFloat(root.getPropertyValue(name)) * parseFloat(root.fontSize);
}
