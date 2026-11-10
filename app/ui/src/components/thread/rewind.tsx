import { createContext, type ReactNode, useState } from "react";

import { ConfirmForm } from "../confirm-dialog";
import { ErrorLine } from "../error-line";
import { Radio, RadioGroup } from "../radio";

/** A user message's rewind: `blocked` says why not right now; `look` asks Rust ahead, so the dialog opens whole. */
export type RewindOffer = { blocked?: string; open: () => void; look?: () => void };
export const RewindContext = createContext<{
  offer: (cid: string, text: string) => RewindOffer | undefined;
  /** Whether this row goes with the rewind under way, so it dims at once [D30]. */
  gone: (n: number | undefined, turn: string | undefined) => boolean;
} | null>(null);

/**
 * Rust's answer: what a restore would put back and leave alone. No paths, no file choice [D481]. `sharer`: the files
 * stay because another session in this folder worked during these turns, or works now [D1078].
 */
export type RewindPreview = { paths: string[]; hand: string[]; leftOut: string[]; commits: boolean; error?: string; sharer?: { id: string; now: boolean } };
type FormProps = { preview: RewindPreview; error?: string; sharerName?: string; onKeep: () => void; onRestore: () => void; onCancel: () => void };

const named = (paths: string[]) => (paths.length > 5 ? `${paths.slice(0, 5).join(", ")} and ${paths.length - 5} more` : paths.join(", "));
const files = (n: number) => (n === 1 ? "1 file" : `${n} files`);

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs break-words text-muted-foreground">{children}</p>;
}

function Choice({ value, label, children }: { value: string; label: string; children: ReactNode }) {
  return (
    <label className="flex gap-2 text-sm">
      <Radio value={value} className="mt-0.5" />
      <span className="flex min-w-0 flex-col gap-0.5">
        {label}
        {children}
      </span>
    </label>
  );
}

/**
 * The confirmation, drawn whole from Rust's answer [D446, D480]: its title, line, Cancel and Rewind; where
 * files can go back, the choice to keep or restore them first [D384, D481].
 */
export function RewindForm({ preview, error, sharerName, onKeep, onRestore, onCancel }: FormProps) {
  const [choice, setChoice] = useState("keep");
  const { paths, hand, leftOut, commits } = preview;
  const can = paths.length > 0;
  return (
    <ConfirmForm
      title="Rewind to this message?"
      description={
        <>
          The chat goes back to just before this message.
          <br />
          Your message returns to the composer.
        </>
      }
      confirm="Rewind"
      disabled={preview.error !== undefined}
      onConfirm={can && choice === "restore" ? onRestore : onKeep}
      onCancel={onCancel}
    >
      {can && (
        <RadioGroup value={choice} onValueChange={(value) => setChoice(String(value))} className="flex flex-col gap-3">
          <Choice value="keep" label="Keep files as they are">
            <Note>Only the chat goes back.</Note>
          </Choice>
          <Choice value="restore" label="Undo the agent's file changes">
            <Note>
              Undoes {files(paths.length)} the agent changed: {named(paths)}.
            </Note>
            {hand.length > 0 && <Note>Left as you edited them: {named(hand)}.</Note>}
            {leftOut.length > 0 && <Note>Too big to go back: {named(leftOut)}.</Note>}
            {commits && <Note>Commits made since then stay.</Note>}
          </Choice>
        </RadioGroup>
      )}
      {preview.sharer && (
        // Proposed words, shown to the owner on screen [D1078].
        <Note>
          Files stay: {sharerName ?? "another session"} {preview.sharer.now ? "is working in this folder now" : "was working in this folder during this turn"}.
        </Note>
      )}
      <ErrorLine error={preview.error ?? error} />
    </ConfirmForm>
  );
}
