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
 * stay because another session in this folder worked during these turns, or works now [D1078]. `nested`: the
 * nested repositories among `leftOut`. `why`: Rust's reason only keep is offered, when it has one [D384]. `stale`: a
 * folder chat's repos missing a snapshot of one of these turns, which stay as they are [D3105].
 */
export type RewindPreview = { paths: string[]; hand: string[]; leftOut: string[]; nested: string[]; stale?: string[]; commits: boolean; error?: string; sharer?: { id: string; now: boolean }; why?: string };
type FormProps = { preview: RewindPreview; error?: string; sharerName?: string; onKeep: () => void; onRestore: () => void; onCancel: () => void };

export const named = (paths: string[]) => (paths.length > 5 ? `${paths.slice(0, 5).join(", ")} and ${paths.length - 5} more` : paths.join(", "));
export const files = (n: number) => (n === 1 ? "1 file" : `${n} files`);

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs break-words text-muted-foreground">{children}</p>;
}

/** What stays as it is: edited since, too big to keep, nested repositories, repos with no snapshot. */
function Stays({ hand, big, nested, stale = [] }: { hand: string[]; big: string[]; nested: string[]; stale?: string[] }) {
  return (
    <>
      {hand.length > 0 && <Note>Left as you edited them: {named(hand)}.</Note>}
      {big.length > 0 && <Note>Too big to go back: {named(big)}.</Note>}
      {nested.length > 0 && <Note>Nested repositories stay as they are: {named(nested)}.</Note>}
      {stale.length > 0 && <Note>No snapshot was taken of these repos for every turn, so they stay as they are: {named(stale)}.</Note>}
    </>
  );
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
/** Rust's reason no file can go back, in one line (D1247's words, the rest proposed); a chat with no project has none to say. */
const CANT: Record<string, string> = {
  unreadable: "Files stay: this turn's snapshot couldn't be read.",
  not_git: "Files can't go back: this folder isn't a git folder.",
  no_folder: "Files can't go back: this session's folder is missing.",
  missing: "Files can't go back: no snapshot was taken of this turn.",
};

export function RewindForm({ preview, error, sharerName, onKeep, onRestore, onCancel }: FormProps) {
  const [choice, setChoice] = useState("keep");
  const { paths, hand, leftOut, nested, stale = [], commits } = preview;
  const big = leftOut.filter((path) => !nested.includes(path));
  const can = paths.length > 0;
  const kept = hand.length + leftOut.length + stale.length > 0;
  const cant = preview.why === undefined ? undefined : CANT[preview.why];
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
              Undoes {files(paths.length)} changed during these turns: {named(paths)}.
            </Note>
            {/* Snapshots can't tell who wrote a file mid-turn, so your edits then are in it [C98]. */}
            <Note>Edits you made while the agent worked are included, and Redo brings them back.</Note>
            <Stays hand={hand} big={big} nested={nested} stale={stale} />
            {/* Snapshots keep no ignored files, so which ones changed can't be said [D1192]. */}
            <Note>Ignored files (like .env) aren't in snapshots and stay as they are.</Note>
            {commits && <Note>Commits made since then stay.</Note>}
          </Choice>
        </RadioGroup>
      )}
      {/* Where nothing can go back, one line says why (D1247, over D481's none); else why some can't. */}
      {!can && !preview.sharer && preview.error === undefined && (cant || (preview.why === undefined && kept)) && (
        <div className="flex flex-col gap-0.5">
          {cant ? (
            <Note>{cant}</Note>
          ) : (
            <>
              <Note>Files stay: nothing the agent changed can go back.</Note>
              <Stays hand={hand} big={big} nested={nested} stale={stale} />
            </>
          )}
        </div>
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
