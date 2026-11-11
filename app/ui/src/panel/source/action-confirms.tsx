import { ConfirmForm } from "../../components/confirm-dialog";
import { Textarea } from "../../components/textarea";
import { Confirm, type Held } from "./dialogs";

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
      <ConfirmForm title="Commit message" description="Commits every change with this message." confirm="Commit" disabled={!message.trim()} onConfirm={onSave} onCancel={onCancel}>
        <Textarea aria-label="Commit message" placeholder={failed ? "Type the commit message" : "The writer writes one"} value={message} autoFocus onChange={(event) => onMessage(event.target.value)} />
      </ConfirmForm>
    </Confirm>
  );
}
