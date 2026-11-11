import { type FormEvent, useState } from "react";

import { Button } from "../components/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { Input } from "../components/input";
import { copyWithToast } from "../components/copy-button";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../components/menu";
import { Copy, Pencil, Pin, Unpin } from "../icons";
import { ArchiveMenuItem } from "../sessions/archive";
import { showToast } from "../components/toast";
import { pin } from "./actions";
import { useBranchPreview } from "./rename-branch";
import type { SessionRow } from "./words";

/** A row's actions, in its ⋯ menu and its right-click menu alike, as the old app worded and grouped them [D185]. */
export function RowMenuItems({ row, onRename }: { row: SessionRow; onRename: () => void }) {
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
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Copy />
          Copy
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {/* Drawn only for now [D204]: the UI doesn't get a session's working folder yet. */}
          <DropdownMenuItem disabled>Copy path</DropdownMenuItem>
          <DropdownMenuItem onClick={() => copyWithToast(row.id, "session id")}>Copy session id</DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <ArchiveMenuItem row={row} />
    </>
  );
}

/** The old app's rename form, with Rust's branch preview pinned on submit. */
export function RenameDialog({ row, onClose, onRename }: { row: SessionRow | null; onClose: () => void; onRename: (title: string, branch?: string) => void }) {
  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>{row && <RenameForm key={row.id} session={row.id} initial={row.title} onClose={onClose} onRename={onRename} />}</DialogContent>
    </Dialog>
  );
}

function RenameForm({ session, initial, onClose, onRename }: { session: string; initial: string; onClose: () => void; onRename: (title: string, branch?: string) => void }) {
  const [value, setValue] = useState(initial);
  const branch = useBranchPreview(session, value);
  const { preview, connected } = branch;
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const title = value.trim();
    if (!title) return setError("Title can't be empty.");
    if (waiting) return;
    if (!connected) return setError("Brigadier isn't connected.");
    if (title !== initial) {
      setWaiting(true);
      setError(null);
      const next = await branch.wait();
      setWaiting(false);
      if (!next) return;
      if (next.state === "disconnected") return setError(next.reason);
      if (next.state === "error") {
        showToast(next.reason, { tone: "error" });
        onRename(title);
      } else onRename(title, next.branch ?? "-");
    }
    onClose();
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Rename session</DialogTitle>
      </DialogHeader>
      <div className="grid gap-1.5">
        <label htmlFor="rename-session" className="text-xs text-muted-foreground">
          Title
        </label>
        <Input id="rename-session" value={value} disabled={waiting} autoFocus maxLength={200} aria-invalid={error !== null} onChange={(event) => setValue(event.target.value)} />
        <p className="min-h-4 text-xs text-muted-foreground" role="status">
          {preview === null ? "Checking branch name…" : preview.state === "ready" && (preview.branch
            ? <>Branch will be renamed to <span className="font-mono break-words">{preview.branch}</span></>
            : preview.reason)}
        </p>
        <ErrorLine error={error ?? (preview && preview.state !== "ready" ? preview.reason : null)} />
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={waiting || !connected}>{waiting ? "Renaming…" : "Rename"}</Button>
      </DialogFooter>
    </form>
  );
}
