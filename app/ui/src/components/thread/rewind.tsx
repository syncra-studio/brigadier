import { createContext, type ReactNode, useState } from "react";

import { ConfirmForm } from "../confirm-dialog";
import { ErrorLine } from "../error-line";
import { Radio, RadioGroup } from "../radio";
import { REWIND_CANT as CANT } from "../../../../shared/words";
import { REWIND_WORDS as W, type RewindPreview, staysWords } from "../../../../shared/session/rewind";
export { files, named } from "../../../../shared/words";

/** A user message's rewind: `blocked` says why not right now; `look` asks Rust ahead, so the dialog opens whole. */
export type RewindOffer = { blocked?: string; open: () => void; look?: () => void };
export const RewindContext = createContext<{
  offer: (cid: string, text: string) => RewindOffer | undefined;
  /** Whether this row goes with the rewind under way, so it dims at once [D30]. */
  gone: (n: number | undefined, turn: string | undefined) => boolean;
} | null>(null);

type FormProps = { preview: RewindPreview; error?: string; sharerName?: string; onKeep: () => void; onRestore: () => void; onCancel: () => void };

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs break-words text-muted-foreground">{children}</p>;
}

/** What stays as it is: edited since, too big to keep, nested repositories, repos with no snapshot. */
function Stays(of: { hand: string[]; big: string[]; nested: string[]; stale?: string[] }) {
  return (
    <>
      {staysWords(of).map((line) => (
        <Note key={line}>{line}</Note>
      ))}
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

export function RewindForm({ preview, error, sharerName, onKeep, onRestore, onCancel }: FormProps) {
  const [choice, setChoice] = useState("keep");
  const { paths, hand, leftOut, nested, stale = [], commits } = preview;
  const big = leftOut.filter((path) => !nested.includes(path));
  const can = paths.length > 0;
  const kept = hand.length + leftOut.length + stale.length > 0;
  const cant = preview.why === undefined ? undefined : CANT[preview.why];
  return (
    <ConfirmForm
      title={W.title}
      description={
        <>
          {W.back}
          <br />
          {W.returns}
        </>
      }
      confirm={W.confirm}
      disabled={preview.error !== undefined}
      onConfirm={can && choice === "restore" ? onRestore : onKeep}
      onCancel={onCancel}
    >
      {can && (
        <RadioGroup value={choice} onValueChange={(value) => setChoice(String(value))} className="flex flex-col gap-3">
          <Choice value="keep" label={W.keep}>
            <Note>{W.keepNote}</Note>
          </Choice>
          <Choice value="restore" label={W.restore}>
            <Note>{W.undoes(paths)}</Note>
            <Note>{W.yours}</Note>
            <Stays hand={hand} big={big} nested={nested} stale={stale} />
            <Note>{W.ignored}</Note>
            {commits && <Note>{W.commits}</Note>}
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
              <Note>{W.nothingBack}</Note>
              <Stays hand={hand} big={big} nested={nested} stale={stale} />
            </>
          )}
        </div>
      )}
      {preview.sharer && (
        <Note>{W.sharer(sharerName, preview.sharer.now)}</Note>
      )}
      <ErrorLine error={preview.error ?? error} />
    </ConfirmForm>
  );
}
