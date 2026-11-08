import { useEffect } from "react";

import { DropdownMenuItem, DropdownMenuShortcut } from "../components/menu";
import { toastManager } from "../components/toast";
import { Archive } from "../icons";
import { store } from "../onboarding/api";
import { archive, restore } from "../sidebar/actions";
import type { SessionRow } from "../sidebar/words";

/*
 * Archive from anywhere, at once, with Undo and ⌘Z [D180, D185, D198], as the old app did: the row menu,
 * ⇧⌘A (the picked rows, else the open one) and ⌘⌫ (the picked rows). ⌘-click and Shift-click pick
 * several. Rust does the work behind the sidebar's queue, which shows each change until its row has it.
 */

/** How long Undo stays, as in the old app. */
const UNDO_MS = 4000;

const picked = store<SessionRow[]>([]);
let anchor: string | null = null;
export const usePicked = picked.use;
export const clearPicked = () => picked.set([]);

/** A row's click: ⌘ toggles it into the pick, Shift picks the range from the last one clicked (or the open one), a plain click clears the pick and opens it. */
export function clickRow(event: { metaKey: boolean; shiftKey: boolean }, row: SessionRow, order: SessionRow[], active: string | null, onOpen: (id: string) => void) {
  if (event.metaKey) {
    const now = picked.get();
    picked.set(now.some((each) => each.id === row.id) ? now.filter((each) => each.id !== row.id) : [...now, row]);
    anchor = row.id;
    return;
  }
  const from = order.findIndex((each) => each.id === (anchor ?? active));
  if (event.shiftKey && from >= 0) {
    const to = order.findIndex((each) => each.id === row.id);
    picked.set(order.slice(Math.min(from, to), Math.max(from, to) + 1));
    return;
  }
  clearPicked();
  anchor = row.id;
  onOpen(row.id);
}

let undo: (() => void) | null = null;
let undoFocus: Element | null = null;
let typedSinceArchive = false;
/** The open session and the way Home, kept by `useArchiveKeys`. */
let view: { active: string | null; onHome: () => void } = { active: null, onHome: () => {} };

/** Archives the rows; an open one goes Home. Undo (and ⌘Z while it shows) brings them back. */
export function archiveRows(rows: SessionRow[]) {
  const { active, onHome } = view;
  if (rows.length === 0) return;
  undoFocus = document.activeElement;
  typedSinceArchive = false;
  clearPicked();
  for (const row of rows) archive(row);
  if (rows.some((row) => row.id === active)) onHome();
  const back = () => {
    undo = null;
    toastManager.close(id);
    for (const row of rows) restore(row);
  };
  undo = back;
  const id = toastManager.add({
    title: rows.length === 1 ? "Archived session" : `Archived ${rows.length} sessions`,
    type: "neutral",
    timeout: UNDO_MS,
    data: { actions: [{ label: "Undo", run: back }] },
    onClose: () => undo === back && (undo = null),
  });
}

/** A field that types text keeps ⌘⌫ for itself. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && (target as HTMLInputElement).type !== "checkbox"));

/** The archive keys and Esc, mounted once by the sidebar: `order` is its rows top to bottom. */
export function useArchiveKeys(order: SessionRow[], active: string | null, onHome: () => void) {
  view = { active, onHome };
  useEffect(() => {
    const onInput = () => { typedSinceArchive = true; };
    const onUndoKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !event.metaKey || event.shiftKey || event.altKey || event.ctrlKey || event.code !== "KeyZ") return;
      if (!undo || document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (typing(event.target) && (typedSinceArchive || event.target === undoFocus)) return;
      event.preventDefault();
      event.stopPropagation();
      undo();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey) return;
      // Not behind a dialog or menu, where what it would archive can't be seen.
      const covered = document.querySelector('[role="dialog"], [role="menu"]') !== null;
      const field = typing(event.target);
      if (event.key === "Escape" && !event.metaKey && !covered && !field) return clearPicked();
      if (!event.metaKey || covered) return;
      const pick = picked.get();
      if (event.shiftKey && event.code === "KeyA") {
        event.preventDefault();
        archiveRows(pick.length > 0 ? pick : order.filter((row) => row.id === active));
      } else if (!event.shiftKey && !field && (event.key === "Backspace" || event.key === "Delete") && pick.length > 0) {
        event.preventDefault();
        archiveRows(pick);
      }
    };
    addEventListener("beforeinput", onInput, true);
    addEventListener("keydown", onUndoKey, true);
    addEventListener("keydown", onKeyDown);
    return () => {
      removeEventListener("beforeinput", onInput, true);
      removeEventListener("keydown", onUndoKey, true);
      removeEventListener("keydown", onKeyDown);
    };
  });
}

/** The row menu's Archive: the picked rows when this is one of several picked, else this one. */
export function ArchiveMenuItem({ row }: { row: SessionRow }) {
  const pick = usePicked();
  const several = pick.length > 1 && pick.some((each) => each.id === row.id);
  return (
    <DropdownMenuItem onClick={() => archiveRows(several ? pick : [row])}>
      <Archive />
      {several ? `Archive (${pick.length})` : "Archive session"}
      <DropdownMenuShortcut>⇧⌘A</DropdownMenuShortcut>
    </DropdownMenuItem>
  );
}

const deleting = store<ReadonlySet<string>>(new Set());
export const hideDeleting = (id: string, on: boolean) => {
  const next = new Set(deleting.get());
  if (on) next.add(id);
  else next.delete(id);
  deleting.set(next);
};

/**
 * The live rows and the archived ones. A delete under way is hidden; one that left something comes back
 * among the archived with what stayed (Rust's `lifecycle.left`) [D35].
 */
export function useArchiveSplit(rows: SessionRow[] | undefined): { live: SessionRow[] | undefined; archived: SessionRow[] } {
  const gone = deleting.use();
  const shown = rows?.filter((row) => !gone.has(row.id) && !(row.lifecycle?.op === "delete" && !row.lifecycle.left));
  const closed = (row: SessionRow) => Boolean(row.archived) || row.lifecycle?.op === "delete";
  return { live: shown?.filter((row) => !closed(row)), archived: (shown ?? []).filter(closed).toSorted((a, b) => (b.archived ?? 0) - (a.archived ?? 0)) };
}
