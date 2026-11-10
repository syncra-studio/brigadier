import { createContext, type ReactNode, useState } from "react";

import { ConfirmForm } from "../confirm-dialog";
import { ErrorLine } from "../error-line";
import { Radio, RadioGroup } from "../radio";

/** A user message's rewind: `blocked` says why not right now. */
export type RewindOffer = { blocked?: string; open: () => void };
export const RewindContext = createContext<{
  offer: (cid: string, text: string) => RewindOffer | undefined;
  /** Whether this row goes with the rewind under way, so it dims at once [D30]. */
  gone: (n: number | undefined, turn: string | undefined) => boolean;
} | null>(null);

/** What a restore would do, from Rust's look at the folder. */
export type RewindFiles = { paths: string[]; hand: string[]; leftOut: string[]; commits: boolean };
/** Rust's answers so far: `restore` is unknown only as the dialog opens, `files` comes a moment later [D446]. */
export type RewindPreview = { error?: string; restore?: boolean; why?: string; files?: RewindFiles };
type FormProps = { preview: RewindPreview; error?: string; onKeep: () => void; onRestore: () => void; onCancel: () => void };

const WHY: Record<string, string> = {
  no_project: "This chat has no project folder, so only the conversation goes back.",
  shared: "Another session works in this folder, so its files stay as they are.",
  missing: "Brigadier has no record of the files at one of these turns, so only the conversation goes back.",
  unreadable: "Brigadier couldn't read this folder, so only the conversation goes back.",
};

const named = (paths: string[]) => (paths.length > 5 ? `${paths.slice(0, 5).join(", ")} and ${paths.length - 5} more` : paths.join(", "));
const files = (n: number) => (n === 1 ? "1 file" : `${n} files`);

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs break-words text-muted-foreground">{children}</p>;
}

/** What a restore puts back and what it leaves alone; nothing until the folder's been looked at. */
function Notes({ files: f, lead }: { files?: RewindFiles; lead: (count: string, paths: string) => string }) {
  if (!f) return null;
  return (
    <>
      <Note>{f.paths.length === 0 ? "No files changed since then." : lead(files(f.paths.length), named(f.paths))}</Note>
      {f.hand.length > 0 && <Note>Left as you edited them: {named(f.hand)}.</Note>}
      {f.leftOut.length > 0 && <Note>Too big to go back: {named(f.leftOut)}.</Note>}
      {f.commits && <Note>Commits made since then stay.</Note>}
    </>
  );
}

function Choice({ value, label, disabled, children }: { value: string; label: string; disabled?: boolean; children: ReactNode }) {
  return (
    <label className="flex gap-2 text-sm">
      <Radio value={value} disabled={disabled} className="mt-0.5" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={disabled ? "text-muted-foreground" : undefined}>{label}</span>
        {children}
      </span>
    </label>
  );
}

/** The confirmation, one choice and one action: keep the files or restore them, then Rewind [D384, D446]. */
export function RewindForm({ preview, error, onKeep, onRestore, onCancel }: FormProps) {
  const [choice, setChoice] = useState("keep");
  const restore = choice === "restore";
  return (
    <ConfirmForm
      title="Rewind to this message?"
      description="The chat goes back to just before it, and the message returns to the composer."
      confirm="Rewind"
      disabled={preview.error !== undefined || (restore && preview.restore !== true)}
      onConfirm={restore ? onRestore : onKeep}
      onCancel={onCancel}
    >
      <RadioGroup value={choice} onValueChange={(value) => setChoice(String(value))} className="flex flex-col gap-3">
        <Choice value="keep" label="Keep files as they are">
          <Note>Only the chat goes back.</Note>
        </Choice>
        <Choice value="restore" label="Restore files too" disabled={preview.restore !== true}>
          {preview.restore === false ? (
            <Note>{WHY[preview.why ?? ""] ?? WHY.missing}</Note>
          ) : preview.files ? (
            <Notes files={preview.files} lead={(count, paths) => `Puts back ${count} the agent changed: ${paths}.`} />
          ) : (
            <Note>Puts back the files the agent changed since then.</Note>
          )}
        </Choice>
      </RadioGroup>
      <ErrorLine error={preview.error ?? error} />
    </ConfirmForm>
  );
}
