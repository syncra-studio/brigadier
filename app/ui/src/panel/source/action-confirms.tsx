import { ConfirmForm } from "../../components/confirm-dialog";
import { TooltipIconButton } from "../../components/icon-button";
import { Textarea } from "../../components/textarea";
import { Check, Spinner, Sparkles, Warning, X } from "../../icons";
import type { Commit, ForcePush } from "../types";
import { plural } from "../words";
import { Confirm, type Held } from "./dialogs";

/**
 * Squash's confirm [D1028]: the message, written from the whole branch and editable, then the commits it folds. With
 * files uncommitted it says they're committed first; nothing is committed until it's confirmed [D1203].
 */
export function SquashDialog({ open, branch, base, commits, files = [], message, writing = false, onMessage, onWrite, held, onCancel, onConfirm }: {
  open: boolean;
  branch: string;
  base: string;
  commits: Commit[];
  /** The files not committed yet, which go in too: named, so it's clear what lands. */
  files?: string[];
  message: string;
  writing?: boolean;
  onMessage: (message: string) => void;
  onWrite?: () => void;
  held?: Held;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Only what there is: no "0 commits" when everything is still uncommitted.
  const parts = [commits.length > 0 && plural(commits.length, "commit"), files.length > 0 && plural(files.length, "uncommitted file")].filter(Boolean);
  const one = commits.length + files.length === 1;
  return (
    <Confirm open={open} onOpenChange={(next) => !next && onCancel()} held={held}>
      <ConfirmForm
        title={`Squash into ${base}?`}
        description={
          <>
            {parts.join(" and ")} from <span className="font-mono text-foreground">{branch}</span> {one ? "becomes" : "become"} one commit on {base}.
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
        {/* Bounded, so a long list scrolls and the buttons stay in view. */}
        <ul className="flex max-h-60 flex-col gap-0.5 overflow-y-auto">
          {commits.map((commit) => (
            <li key={commit.sha} className="flex h-control-sm items-center gap-2 ps-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
              <span className="font-mono text-xs text-muted-foreground">{commit.sha}</span>
            </li>
          ))}
          {files.map((path) => (
            <li key={path} className="flex h-control-sm items-center gap-2 ps-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{path}</span>
              <span className="text-xs text-muted-foreground">Uncommitted</span>
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
          // Clear of the close button, a long ref wrapping onto a second line.
          title={<span className="block pe-7 leading-5">{force.movedTo ? `${force.remoteRef} moved. Force push anyway?` : `Force push ${branch}?`}</span>}
          description={
            force.movedTo
              ? `It's at ${force.movedTo.slice(0, 7)} now, not ${force.reviewed.slice(0, 7)} as when you looked. Force pushing replaces those commits too.`
              : `${force.remoteRef} has commits this branch doesn't. Force pushing replaces them with your branch, only if it's still at ${force.reviewed.slice(0, 7)}.`
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

/**
 * Edit message… [D1191, D1203]: the next commit's message in the kit's multi-line field, filled with what was saved,
 * else the drafted one (2.20). Save keeps it for the button's commit and Commit only; a blank one goes back to the
 * writer's (proposed).
 */
export function MessageDialog({ open, message, failed = false, held, onMessage, onCancel, onSave }: {
  open: boolean;
  message: string;
  /** The writer just failed: it won't write one, so the field asks for it (proposed words). */
  failed?: boolean;
  held?: Held;
  onMessage: (message: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <Confirm open={open} onOpenChange={(next) => !next && onCancel()} held={held}>
      <ConfirmForm title="Commit message" description="The next commit uses it, from the button or Commit only." confirm="Save" onConfirm={onSave} onCancel={onCancel}>
        <Textarea aria-label="Commit message" placeholder={failed ? "Type the commit message" : "The writer writes one"} value={message} autoFocus onChange={(event) => onMessage(event.target.value)} />
      </ConfirmForm>
    </Confirm>
  );
}
