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
import { Copy, FolderOpen, Pencil, Pin, Settings, Spinner, Unpin } from "../icons";
import { openProject } from "../projects/page";
import { ArchiveMenuItem } from "../sessions/archive";
import { DeleteMenuItem } from "../sessions/archived";
import { ForkMenuItem } from "../session/fork";
import { ask, useFolderChat } from "../daemon";
import { showToast } from "../components/toast";
import { keysOf } from "../shortcuts";
import { pin } from "./actions";
import { LabelMenu } from "./labels";
import { useBranchPreview } from "./rename-branch";
import type { Project, SessionRow } from "./words";

/** A row's actions, in its ⋯ menu and its right-click menu alike, as the old app worded and grouped them [D185]; with `project`, its settings too, where no row of the project's own has them. */
export function RowMenuItems({ row, project, canPin = true, onRename, onFork }: { row: SessionRow; project?: Project; canPin?: boolean; onRename: () => void; onFork?: () => void }) {
  const pinned = Boolean(row.pinned);
  const folder = useFolderChat(row.id);
  const copies: [string, string | null | undefined][] = [
    ["ID", row.id],
    ["absolute path", row.folder],
  ];
  return (
    <>
      {canPin && (
        <DropdownMenuItem onClick={() => pin(row, !pinned)}>
          {pinned ? <Unpin /> : <Pin />}
          {pinned ? "Unpin" : "Pin"}
          <DropdownMenuShortcut>{keysOf("pin")[0]}</DropdownMenuShortcut>
        </DropdownMenuItem>
      )}
      <LabelMenu row={row} />
      <DropdownMenuItem onClick={onRename}>
        <Pencil />
        Rename
        <DropdownMenuShortcut>{keysOf("rename")[0]}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <ForkMenuItem row={row} onFork={onFork} />
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Copy />
          Copy
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {copies.map(([what, value]) => value && <DropdownMenuItem key={what} onClick={() => copyWithToast(value, what)}>{what[0]!.toUpperCase() + what.slice(1)}</DropdownMenuItem>)}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {project && (
        <DropdownMenuItem onClick={() => openProject(project.id)}>
          <Settings />
          Project settings
        </DropdownMenuItem>
      )}
      {/* Its working directory [D37]; Rust's Files reveal of the checkout itself (""). */}
      {row.project && row.folder && !folder && (
        <DropdownMenuItem onClick={() => ask({ op: "run", args: ["source", row.id, "reveal", ""] }, (reply) => !reply.ok && showToast(`Couldn't reveal ${row.title}: ${String(reply.error)}`, { tone: "error" }))}>
          <FolderOpen />
          Reveal in Finder
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <ArchiveMenuItem row={row} />
      {/* Off for a folder chat: delete's check doesn't see its repos' branches yet [D494, D3102]. */}
      {!folder && <DeleteMenuItem row={row} />}
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
        {/* Two lines kept for it, so Rust's answer comes in without a jump or a "checking" line; the branch alone on the second [D1261]. */}
        <p className="min-h-8 text-xs text-muted-foreground" role="status">
          {preview?.state === "ready" && (preview.branch
            ? <>Branch will be renamed to<br /><span className="font-mono font-medium break-words text-foreground">{preview.branch}</span></>
            : preview.reason)}
        </p>
        <ErrorLine error={error ?? (preview && preview.state !== "ready" ? preview.reason : null)} />
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={waiting || !connected}>
          {waiting && <Spinner className="size-icon-xs animate-spin motion-reduce:animate-none" />}
          Rename
        </Button>
      </DialogFooter>
    </form>
  );
}
