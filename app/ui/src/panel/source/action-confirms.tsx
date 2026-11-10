import { ConfirmForm } from "../../components/confirm-dialog";
import { TooltipIconButton } from "../../components/icon-button";
import { Check, Spinner, Sparkles, Warning, X } from "../../icons";
import type { Checks, Commit, ForcePush } from "../types";
import { plural } from "../words";
import { Confirm, type Held } from "./dialogs";

/** Squash's confirm [D1028]: the message, written from the whole branch and editable, then the commits it folds. */
export function SquashDialog({ open, branch, base, commits, message, writing = false, onMessage, onWrite, held, onCancel, onConfirm }: {
  open: boolean;
  branch: string;
  base: string;
  commits: Commit[];
  message: string;
  writing?: boolean;
  onMessage: (message: string) => void;
  onWrite?: () => void;
  held?: Held;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Confirm open={open} onOpenChange={(next) => !next && onCancel()} held={held}>
      <ConfirmForm
        title={`Squash into ${base}?`}
        description={
          <>
            {plural(commits.length, "commit")} from <span className="font-mono text-foreground">{branch}</span> become one commit on {base}.
          </>
        }
        confirm="Squash and merge"
        disabled={!message.trim() || writing}
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-label">Message</span>
            <TooltipIconButton tooltip="Write it again" size="icon-xs" disabled={writing} onClick={onWrite}>
              {writing ? <Spinner className="animate-spin motion-reduce:animate-none" /> : <Sparkles />}
            </TooltipIconButton>
          </div>
          <textarea
            aria-label="Squash message"
            placeholder={writing ? "Writing message…" : undefined}
            value={message}
            disabled={writing}
            onChange={(event) => onMessage(event.target.value)}
            className="max-h-60 w-full resize-none rounded-control border border-transparent bg-fill px-2.5 py-1.5 text-sm outline-none field-sizing-content focus-visible:border-ring"
          />
        </div>
        <ul className="flex flex-col gap-0.5">
          {commits.map((commit) => (
            <li key={commit.sha} className="flex h-control-sm items-center gap-2 ps-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
              <span className="font-mono text-xs text-muted-foreground">{commit.sha}</span>
            </li>
          ))}
        </ul>
      </ConfirmForm>
    </Confirm>
  );
}

/** Merge #12's confirm [D1019]: where its checks and review stand, as the host last said. */
export function MergePrDialog({ open, pr, base, checks, held, onCancel, onConfirm }: {
  open: boolean;
  pr: number;
  base: string;
  checks: Checks;
  held?: Held;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const rows = [
    checks.failed > 0 && { icon: <X className="text-destructive" />, text: `${plural(checks.failed, "check")} failed` },
    checks.running > 0 && { icon: <Spinner className="text-muted-foreground" />, text: `${plural(checks.running, "check")} still running` },
    checks.passed > 0 && { icon: <Check className="text-success" />, text: `${plural(checks.passed, "check")} passed` },
    checks.approved ? { icon: <Check className="text-success" />, text: "Approved" } : { icon: <Warning className="text-warning" />, text: "Not approved yet" },
  ].filter((row) => row !== false);
  return (
    <Confirm open={open} onOpenChange={(next) => !next && onCancel()} held={held}>
      <ConfirmForm title={`Merge #${pr} into ${base}?`} description={`#${pr} is merged on its host and closed.`} confirm={`Merge #${pr}`} onConfirm={onConfirm} onCancel={onCancel}>
        <ul className="flex flex-col gap-1 text-sm">
          {rows.map((row) => (
            <li key={row.text} className="flex items-center gap-2 svg:size-icon-sm">
              {row.icon}
              {row.text}
            </li>
          ))}
        </ul>
      </ConfirmForm>
    </Confirm>
  );
}

/**
 * Force push with lease, offered only after a rejected push [D1034]. It pins the remote commit the user reviewed; if
 * the remote moved since, it says so and asks again rather than overwrite what they haven't seen [D1049].
 */
export function ForcePushDialog({ force, branch, held, onCancel, onConfirm }: { force: ForcePush | null; branch: string; held?: Held; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Confirm open={force !== null} onOpenChange={(next) => !next && onCancel()} held={held}>
      {force && (
        <ConfirmForm
          title={force.movedTo ? `${force.remoteRef} moved. Force push anyway?` : `Force push ${branch}?`}
          description={
            force.movedTo
              ? `It's at ${force.movedTo} now, not ${force.reviewed} as when you looked. Force pushing replaces those commits too.`
              : `${force.remoteRef} has commits this branch doesn't. Force pushing replaces them with your branch, only if it's still at ${force.reviewed}.`
          }
          confirm="Force Push"
          destructive
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      )}
    </Confirm>
  );
}
