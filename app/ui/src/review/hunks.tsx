import { Minus, Plus, Spinner, Undo } from "../icons";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { ConfirmDialog } from "../components/confirm-dialog";
import { ErrorLine } from "../components/error-line";
import type { HunkAction, RequestState, ReviewFile, ReviewHunk, ReviewRequest, ReviewScope } from "./types";

/**
 * Stage and revert by hunk and by file (D1043): each hunk gets a bar right above its first change with its @@ line,
 * its counts and its actions; the file header gets the same for the whole file. Revert asks first, in the old Source
 * panel's discard words. Branch since base has none: it is already committed.
 */

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Whether a scope's diff can be staged or reverted (D1035, D1043). */
export const actionable = (scope: ReviewScope) => scope !== "branch";

/** "+3 −1" as the old Counts drew it: mono, tabular, green and red, a zero dim. */
export function Counts({ insertions, deletions }: { insertions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      <span className={insertions === 0 ? "text-muted-foreground" : "text-success"}>+{insertions}</span>{" "}
      <span className={deletions === 0 ? "text-muted-foreground" : "text-destructive"}>−{deletions}</span>
    </span>
  );
}

const LABELS: Record<HunkAction, string> = { stage: "Stage", unstage: "Unstage", revert: "Revert" };
const ICONS = { stage: Plus, unstage: Minus, revert: Undo };

/** Revert, then Stage or Unstage; the one asked shows a spinner and both wait while it works (D30). */
export function Actions({
  staged,
  noun,
  state,
  disabled,
  onAction,
}: {
  staged: boolean;
  /** "hunk", or nothing for the file's own. */
  noun?: string;
  state: RequestState | undefined;
  disabled: boolean;
  onAction: (action: HunkAction) => void;
}) {
  const pending = state && "pending" in state ? state.pending : null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {(["revert", staged ? "unstage" : "stage"] as const).map((action) => {
        const Icon = pending === action ? Spinner : ICONS[action];
        return (
          <Button
            key={action}
            variant={action === "revert" ? "soft-destructive" : "soft"}
            size="xs"
            disabled={disabled || pending !== null}
            onClick={() => onAction(action)}
          >
            <Icon className={pending === action ? "motion-safe:animate-spin" : undefined} />
            {noun ? `${LABELS[action]} ${noun}` : LABELS[action]}
          </Button>
        );
      })}
    </span>
  );
}

/** A hunk's bar: its @@ line and counts, Staged when it's in the index, a failure's reason, then its actions. */
export function HunkBar({
  hunk,
  state,
  disabled,
  onAction,
}: {
  hunk: ReviewHunk;
  state: RequestState | undefined;
  disabled: boolean;
  onAction: (action: HunkAction) => void;
}) {
  return (
    <div data-slot="hunk-bar" className="flex h-control-md items-center gap-2 border-y border-border bg-fill-subtle ps-3 pe-2 font-sans text-xs">
      <span className="shrink-0 font-mono text-link">{hunk.header}</span>
      <Counts insertions={hunk.insertions} deletions={hunk.deletions} />
      {hunk.staged && <Badge variant="success">Staged</Badge>}
      <ErrorLine error={state && "error" in state ? state.error : null} className="min-w-0 truncate" />
      <span className="flex-1" />
      <Actions staged={hunk.staged} noun="hunk" state={state} disabled={disabled} onAction={onAction} />
    </div>
  );
}

const lines = (hunk: ReviewHunk) => (hunk.start === hunk.end ? `Line ${hunk.start}` : `Lines ${hunk.start}–${hunk.end}`);

/** What reverting a file throws away, in the old Source panel's words. */
function fileWords(scope: ReviewScope, file: ReviewFile): string {
  if (scope === "unstaged") {
    return file.status === "untracked"
      ? `${file.path} is deleted. Git doesn't track it, so it can't be brought back.`
      : `The changes to ${file.path} that aren't staged are lost. Its staged changes stay.`;
  }
  const back =
    file.status === "added" || file.status === "untracked"
      ? `${file.path} is new, so it's deleted.`
      : file.status === "renamed"
        ? `${file.path} goes back to ${file.from ?? "its old name"} as it was last committed.`
        : `${file.path} goes back to how it was last committed.`;
  return scope === "uncommitted" ? `${back} Its changes that aren't staged are lost too.` : back;
}

/** A revert's confirm: its title, its line and its button. */
export function revertWords(scope: ReviewScope, file: ReviewFile, hunk: ReviewHunk | null) {
  const name = baseName(file.path);
  if (hunk) {
    return {
      title: `Revert this ${hunk.staged ? "staged " : ""}change to ${name}?`,
      description: `${lines(hunk)} of ${file.path} ${hunk.start === hunk.end ? "goes" : "go"} back to how ${hunk.start === hunk.end ? "it was" : "they were"} last committed${hunk.staged ? ", staged or not" : ""}. Its other changes stay.`,
      confirm: "Revert",
    };
  }
  const untracked = scope === "unstaged" && file.status === "untracked";
  return {
    title: untracked ? `Delete ${name}?` : `Discard ${scope === "staged" ? "staged " : ""}changes to ${name}?`,
    description: fileWords(scope, file),
    confirm: untracked ? "Delete" : "Discard",
  };
}

/** The revert being asked about, by its request and what it names. */
export type Asking = { request: ReviewRequest; file: ReviewFile; hunk: ReviewHunk | null };

export function RevertConfirm({
  scope,
  asking,
  onClose,
  onConfirm,
}: {
  scope: ReviewScope;
  asking: Asking | null;
  onClose: () => void;
  onConfirm: (request: ReviewRequest) => void;
}) {
  const words = asking && revertWords(scope, asking.file, asking.hunk);
  return (
    <ConfirmDialog
      open={asking !== null}
      onOpenChange={(open) => !open && onClose()}
      title={words?.title ?? null}
      description={words?.description}
      confirm={words?.confirm ?? "Revert"}
      destructive
      onConfirm={() => {
        if (asking) onConfirm(asking.request);
        onClose();
      }}
    />
  );
}
