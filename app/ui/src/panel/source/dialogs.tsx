import type { ReactNode } from "react";

import { Button } from "../../components/button";
import { ConfirmForm } from "../../components/confirm-dialog";
import { copyWithToast } from "../../components/copy-button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/dialog";
import type { SourceFile } from "../types";
import { baseName, discardWords } from "../words";

/*
 * The Source panel's confirms and Git Output, in the old panel's exact words. `held` is the gallery's box: the
 * dialog shows there, open, not modal.
 */

export type Held = HTMLElement | undefined;

/** A dialog around a confirm's form, placed in `held` when the gallery holds it. */
export function Confirm({ open, onOpenChange, held, children }: { open: boolean; onOpenChange: (open: boolean) => void; held?: Held; children: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={held ? false : undefined}>
      <DialogContent container={held} initialFocus={held ? false : undefined}>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export type Discarding = { scope: "staged" | "unstaged"; files: SourceFile[] };

/** Discard's confirm: one file's changes, a new file Git doesn't track (deleted), or many files. */
export function DiscardDialog({ discarding, unstagedPaths, held, onCancel, onConfirm }: {
  discarding: Discarding | null;
  unstagedPaths: ReadonlySet<string>;
  held?: Held;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const file = discarding?.files[0];
  const many = (discarding?.files.length ?? 0) > 1;
  const untracked = !many && discarding?.scope === "unstaged" && file?.status === "untracked";
  return (
    <Confirm open={discarding !== null} onOpenChange={(open) => !open && onCancel()} held={held}>
      {discarding && file && (
        <ConfirmForm
          title={
            many
              ? `Discard all changes in ${discarding.files.length} files?`
              : untracked
                ? `Delete ${baseName(file.path)}?`
                : `Discard ${discarding.scope === "staged" ? "staged " : ""}changes to ${baseName(file.path)}?`
          }
          description={
            many
              ? "Their changes that aren't staged are lost, and new files Git doesn't track are deleted. This can't be undone."
              : discardWords(discarding.scope, file, discarding.scope === "staged" && unstagedPaths.has(file.path))
          }
          confirm={untracked ? "Delete" : "Discard"}
          destructive
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      )}
    </Confirm>
  );
}

/** Staging a conflicted file that still has conflict markers. */
export function StageConflictsDialog({ staging, held, onCancel, onConfirm }: { staging: { paths: string[]; marked: number } | null; held?: Held; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Confirm open={staging !== null} onOpenChange={(open) => !open && onCancel()} held={held}>
      {staging && (
        <ConfirmForm
          title={staging.paths.length === 1 ? `Stage ${baseName(staging.paths[0]!)} with its conflicts?` : `Stage ${staging.marked} ${staging.marked === 1 ? "file" : "files"} with conflicts?`}
          description={`${staging.paths.length === 1 ? "It still has" : "They still have"} conflict markers. Staging marks the conflicts resolved, and the markers would be committed as they are.`}
          confirm="Stage"
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      )}
    </Confirm>
  );
}

export function DropStashDialog({ open, held, onCancel, onConfirm }: { open: boolean; held?: Held; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Confirm open={open} onOpenChange={(next) => !next && onCancel()} held={held}>
      <ConfirmForm title="Drop the latest stash?" description="Its changes are deleted for good." confirm="Drop" destructive onConfirm={onConfirm} onCancel={onCancel} />
    </Confirm>
  );
}

/** Commit with nothing staged: Cursor's question and answers, as the old panel asked it. Escape leaves it unanswered. */
export function StageAllDialog({ open, held, onClose, onAnswer }: { open: boolean; held?: Held; onClose: () => void; onAnswer: (answer: "yes" | "always" | "never") => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()} modal={held ? false : undefined}>
      <DialogContent container={held} initialFocus={held ? false : undefined} showCloseButton={false}>
        <DialogTitle className="sr-only">Commit</DialogTitle>
        <DialogDescription className="text-sm text-foreground">There are no staged changes to commit. Would you like to stage all your changes and commit them directly?</DialogDescription>
        <DialogFooter data-confirm>
          <Button variant="ghost" onClick={() => onAnswer("never")}>
            Never
          </Button>
          <Button variant="secondary" onClick={() => onAnswer("always")}>
            Always
          </Button>
          <Button autoFocus onClick={() => onAnswer("yes")}>
            Yes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type GitRun = { atMs: number; command: string; output: string; ok: boolean };

const time = (atMs: number) => new Date(atMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const runText = (run: GitRun) => `${time(run.atMs)}  > ${run.command}${run.output ? `\n${run.output}` : ""}`;

/** What the Source panel ran on this checkout, oldest first, a failure's output in red; Copy takes it all. Null while it loads. */
export function GitOutputDialog({ runs, held, onClose }: { runs: GitRun[] | null | "closed"; held?: Held; onClose: () => void }) {
  return (
    <Dialog open={runs !== "closed"} onOpenChange={(open) => !open && onClose()} modal={held ? false : undefined}>
      <DialogContent container={held} initialFocus={held ? false : undefined} frame="max-w-git-output gap-4 p-5">
        <DialogHeader>
          <DialogTitle>Git Output</DialogTitle>
          <DialogDescription>What the Source panel ran here, newest last.</DialogDescription>
        </DialogHeader>
        <pre className="max-h-96 overflow-auto rounded-control bg-fill-subtle p-3 font-mono text-xs whitespace-pre-wrap text-quiet-foreground">
          {runs === null && <span className="text-muted-foreground">Loading…</span>}
          {runs !== null && runs !== "closed" && runs.length === 0 && <span className="text-muted-foreground">Nothing ran yet.</span>}
          {runs !== null &&
            runs !== "closed" &&
            runs.map((run, index) => (
              <span key={`${run.atMs}-${index}`} className="block pb-2">
                <span className="text-muted-foreground">{time(run.atMs)} </span>
                <span className="text-foreground">&gt; {run.command}</span>
                {run.output && "\n"}
                {run.output && <span className={run.ok ? undefined : "text-destructive"}>{run.output}</span>}
              </span>
            ))}
        </pre>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={runs === null || runs === "closed" || runs.length === 0} onClick={() => Array.isArray(runs) && copyWithToast(runs.map(runText).join("\n\n"), "Git Output")}>
            Copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
