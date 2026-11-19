import { type FormEvent, useState } from "react";

import { Button } from "../components/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { Input } from "../components/input";
import { copyWithToast } from "../components/copy-button";
import { useDaemon } from "../daemon";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../components/menu";
import { Copy, Pencil, Pin, Spinner, Unpin } from "../icons";
import { useGit } from "../panel/git";
import { ArchiveMenuItem } from "../sessions/archive";
import { showToast } from "../components/toast";
import { keysOf } from "../shortcuts";
import { pin } from "./actions";
import { useBranchPreview } from "./rename-branch";
import type { SessionRow } from "./words";

/** A row's actions, in its ⋯ menu and its right-click menu alike, as the old app worded and grouped them [D185]. */
export function RowMenuItems({ row, canPin = true, onRename }: { row: SessionRow; canPin?: boolean; onRename: () => void }) {
  const pinned = Boolean(row.pinned);
  const projects = useDaemon().projects;
  const git = useGit();
  // The branch is the git watch's, which follows the shown session: its tab's menu always has it [D243].
  const branch = git.target && "session" in git.target && git.target.session === row.id ? (git.source?.branch ?? git.truth?.branch) : null;
  // Every session's four copies, each when it has the value [D232, D243].
  const copies: [string, string | null | undefined][] = [
    ["session ID", row.id],
    ["session path", row.folder],
    ["project path", projects?.find((each) => each.id === row.project)?.folder],
    ["branch name", branch],
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
      <DropdownMenuItem onClick={onRename}>
        <Pencil />
        Rename
        <DropdownMenuShortcut>{keysOf("rename")[0]}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Copy />
          Copy
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {copies.map(([what, value]) => value && <DropdownMenuItem key={what} onClick={() => copyWithToast(value, what)}>Copy {what}</DropdownMenuItem>)}
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
