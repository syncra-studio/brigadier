import { useRef, useState } from "react";

import { ConfirmForm } from "../confirm-dialog";
import { Dialog, DialogContent } from "../dialog";

/**
 * "Switch to X?": the chat goes on with another agent, as a new conversation it hands what's done to. `fork`: the
 * same confirm with Fork's words, naming the agent before the conversation goes to it [D90, D162, D1071].
 */
export function SwitchAgentDialog({
  to,
  onCancel,
  onConfirm,
  held,
  fork = false,
}: {
  /** The agent's name; null while closed. */
  to: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  /** The gallery's box to hold it open in, not modal and not taking focus. */
  held?: HTMLElement;
  fork?: boolean;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  // Kept while the dialog animates out.
  const [name, setName] = useState(to ?? "");
  if (to !== null && to !== name) setName(to);
  return (
    <Dialog open={to !== null} modal={!held} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent container={held} initialFocus={held ? false : confirm}>
        <ConfirmForm
          title={fork ? `Fork to ${name}?` : `Switch to ${name}?`}
          description={
            fork
              ? `The fork goes on with ${name} in a new conversation, and it gets everything up to this answer.`
              : `The chat goes on with ${name} in a new conversation, and it gets everything so far, so nothing is lost.`
          }
          confirm={fork ? "Fork" : "Switch"}
          onCancel={onCancel}
          onConfirm={onConfirm}
          confirmRef={confirm}
        />
      </DialogContent>
    </Dialog>
  );
}

