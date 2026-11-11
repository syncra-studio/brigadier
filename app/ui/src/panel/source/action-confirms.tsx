import { ConfirmForm } from "../../components/confirm-dialog";
import { Textarea } from "../../components/textarea";
import type { ForcePush } from "../types";
import { Confirm, type Held } from "./dialogs";

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
 * Type a message… [D1203, D1293]: the next commit's message in the kit's multi-line field, after the writer couldn't
 * write one.
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
