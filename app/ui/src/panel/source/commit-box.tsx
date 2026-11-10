import { ErrorLine } from "../../components/error-line";
import { TooltipIconButton } from "../../components/icon-button";
import { Textarea } from "../../components/textarea";
import { Sparkles, Spinner } from "../../icons";

/**
 * The commit message field above the action button [D1029, D1107]: its grey placeholder is the drafted message, which
 * a blank field commits; typing edits the whole message, subject and body; ✨ writes one now. During a merge it holds
 * git's message, during a rebase the stopped commit's, kept as it is. A write that failed says so under it, and
 * nothing was committed.
 */
export function CommitBox({ message, onMessage, branch, draft = null, rebaseMessage = null, writing = false, busy = false, canWrite, failed = false, error = null, includes = null, onWrite, onCommit }: {
  message: string;
  onMessage: (message: string) => void;
  branch: string | null;
  /** The message drafted for the work so far (2.20); null until one is ready. */
  draft?: string | null;
  /** A rebase stopped on this commit: its message, which the field shows and doesn't edit. */
  rebaseMessage?: string | null;
  /** ✨ is writing a message. */
  writing?: boolean;
  /** A commit or a write is under way. */
  busy?: boolean;
  canWrite: boolean;
  failed?: boolean;
  /** A commit Rust refused, in its words. */
  error?: string | null;
  /** Another session in this folder made changes still uncommitted here: the field says so [D1082, D1107]. */
  includes?: string | null;
  onWrite?: () => void;
  onCommit?: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        value={rebaseMessage ?? message}
        disabled={busy || rebaseMessage !== null}
        aria-label="Commit message"
        placeholder={draft ?? `Message (⌘⏎ to commit on "${branch ?? "…"}")`}
        onChange={(event) => onMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.metaKey) {
            event.preventDefault();
            onCommit?.();
          }
        }}
        end={
          <TooltipIconButton tooltip="Generate Commit Message" size="icon-xs" disabled={busy || !canWrite} onClick={onWrite}>
            {writing ? <Spinner className="animate-spin motion-reduce:animate-none" /> : <Sparkles />}
          </TooltipIconButton>
        }
      />
      {includes && <p className="px-1 text-xs text-muted-foreground">Includes changes from {includes}</p>}
      {failed && <ErrorLine error="Couldn't write a message. Type one." className="px-1" />}
      {error && <ErrorLine error={error} className="px-1" />}
    </div>
  );
}
