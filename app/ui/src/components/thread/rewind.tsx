import { createContext, type ReactNode } from "react";

import { Spinner } from "../../icons";
import { Button } from "../button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../dialog";
import { ErrorLine } from "../error-line";

/** A user message's rewind: `blocked` says why not right now. */
export type RewindOffer = { blocked?: string; open: () => void };
export const RewindContext = createContext<{
  offer: (cid: string, text: string) => RewindOffer | undefined;
  /** Whether this row goes with the rewind under way, so it dims at once [D30]. */
  gone: (n: number | undefined, turn: string | undefined) => boolean;
} | null>(null);

export type RewindPreview =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; restore: boolean; why?: string; paths: string[]; hand: string[]; leftOut: string[]; commits: boolean };

const WHY: Record<string, string> = {
  no_project: "This chat has no project folder, so only the conversation goes back.",
  shared: "Another session works in this folder, so its files stay as they are.",
  missing: "Brigadier has no record of the files at one of these turns, so only the conversation goes back.",
  unreadable: "Brigadier couldn't read this folder, so only the conversation goes back.",
};

const named = (paths: string[]) => (paths.length > 5 ? `${paths.slice(0, 5).join(", ")} and ${paths.length - 5} more` : paths.join(", "));

function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm break-words text-muted-foreground">{children}</p>;
}

/** The confirmation's inside: what going back does, then Keep files or Restore files [D384]. */
export function RewindForm({ preview, error, onKeep, onRestore, onCancel }: { preview: RewindPreview; error?: string; onKeep: () => void; onRestore: () => void; onCancel: () => void }) {
  const ready = preview.status === "ready" ? preview : null;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Rewind to this message?</DialogTitle>
        <DialogDescription>The conversation goes back to just before it, and the message returns to the composer.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        {preview.status === "loading" && (
          <p role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Spinner className="size-icon-xs animate-spin motion-reduce:animate-none" />
            Checking the folder…
          </p>
        )}
        {ready && !ready.restore && <Note>{WHY[ready.why ?? ""] ?? WHY.missing}</Note>}
        {ready?.restore && <Note>{ready.paths.length === 0 ? "No files need to go back." : `Restoring puts back ${ready.paths.length === 1 ? "1 file" : `${ready.paths.length} files`}: ${named(ready.paths)}.`}</Note>}
        {ready?.restore && ready.hand.length > 0 && <Note>Left as you edited them: {named(ready.hand)}.</Note>}
        {ready?.restore && ready.leftOut.length > 0 && <Note>Too big to go back: {named(ready.leftOut)}.</Note>}
        {ready?.restore && ready.commits && <Note>Commits made since then stay.</Note>}
        <ErrorLine error={preview.status === "error" ? preview.error : error} />
      </div>
      <DialogFooter data-confirm>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="secondary" disabled={preview.status === "error"} onClick={onKeep}>
          Keep files
        </Button>
        <Button disabled={!ready?.restore} onClick={onRestore}>
          Restore files
        </Button>
      </DialogFooter>
    </>
  );
}
