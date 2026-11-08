import { type FormEvent, useState } from "react";

import { Button } from "../components/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { Input } from "../components/input";
import { DropdownMenuItem, DropdownMenuShortcut } from "../components/menu";
import { Dot, Pencil, Pin, Unpin } from "../icons";
import { ArchiveMenuItem } from "../sessions/archive";
import { markUnread, pin } from "./actions";
import type { SessionRow } from "./words";

/** A row's actions, in its ⋯ menu and its right-click menu alike, as the old app worded them [D185]. */
export function RowMenuItems({ row, active, onRename }: { row: SessionRow; active: boolean; onRename: () => void }) {
  const pinned = Boolean(row.pinned);
  return (
    <>
      <DropdownMenuItem onClick={() => pin(row, !pinned)}>
        {pinned ? <Unpin /> : <Pin />}
        {pinned ? "Unpin" : "Pin"}
        <DropdownMenuShortcut>⌥⌘P</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onRename}>
        <Pencil />
        Rename
        <DropdownMenuShortcut>⌥⌘R</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem disabled={row.mark === "unread"} onClick={() => markUnread(row, active)}>
        <Dot />
        Mark as unread
        <DropdownMenuShortcut>⇧⌘U</DropdownMenuShortcut>
      </DropdownMenuItem>
      <ArchiveMenuItem row={row} />
    </>
  );
}

/** The old app's rename form: one field, checked here for empty, the rest by Rust. */
export function RenameDialog({ row, onClose, onRename }: { row: SessionRow | null; onClose: () => void; onRename: (title: string) => void }) {
  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>{row && <RenameForm initial={row.title} onClose={onClose} onRename={onRename} />}</DialogContent>
    </Dialog>
  );
}

function RenameForm({ initial, onClose, onRename }: { initial: string; onClose: () => void; onRename: (title: string) => void }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const title = value.trim();
    if (!title) return setError("Title can't be empty.");
    if (title !== initial) onRename(title);
    onClose();
  };
  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Rename session</DialogTitle>
      </DialogHeader>
      <div className="grid gap-1.5">
        <label htmlFor="rename-session" className="text-xs text-muted-foreground">
          Title
        </label>
        <Input id="rename-session" value={value} autoFocus maxLength={200} aria-invalid={error !== null} onChange={(event) => setValue(event.target.value)} />
        <ErrorLine error={error} />
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">Rename</Button>
      </DialogFooter>
    </form>
  );
}
