// The tray under the frames, always there [D2055]: every unsent note with its variant and a ✕ each, the
// note for all variants (proposed, w13), Send ⌘↩ with Retry on a failure, Use's confirm, and what a stopped worker,
// an older round or the built pick leaves to do.
import { type ReactNode, useState } from "react";

import { Button } from "../components/button";
import { Input } from "../components/input";
import { Kbd } from "../components/kbd";
import { Pencil, X } from "../icons";
import { keysOf } from "../shortcuts";
import { markerNumber, type MockupNote, noteCount, type Notes } from "./notes";
import { Marker } from "./pins";

const LINE = "flex min-w-0 items-center gap-2";

export type Send = "idle" | "sending" | "failed";

/** "1 note", "3 notes". */
const count = (n: number) => (n === 1 ? "1 note" : `${n} notes`);

/** One note in the tray: its pin's number, variant and words, with ✎ and ✕. */
function NoteChip({ note, number, onChange, onRemove }: { note: MockupNote; number: number; onChange?: (text: string) => void; onRemove?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  return (
    <li className="flex min-w-0 items-center gap-1.5 rounded-control bg-card px-2 py-1 text-xs">
      <Marker small number={number} label={`Comment ${number}`} />
      <b className="shrink-0">{note.variant}</b>
      {editing && onChange ? (
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => { event.preventDefault(); if (text.trim()) onChange(text.trim()); setEditing(false); }}
        >
          <input
            autoFocus
            aria-label="Comment"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setText(note.text); setEditing(false); } }}
            onBlur={() => setEditing(false)}
            className="w-full bg-transparent outline-none"
          />
        </form>
      ) : (
        <span className="min-w-0 flex-1 truncate">· {note.text}</span>
      )}
      {onChange && !editing && (
        <Button variant="ghost" size="icon-xs" aria-label={`Edit comment ${number}`} onClick={() => { setText(note.text); setEditing(true); }}>
          <Pencil />
        </Button>
      )}
      {onRemove && (
        <Button variant="ghost" size="icon-xs" aria-label={`Remove comment ${number}`} onClick={onRemove}>
          <X />
        </Button>
      )}
    </li>
  );
}

/** The notes as a list, editable unless `fixed`. */
function NoteList({ notes, onNotes }: { notes: Notes; onNotes?: (notes: Notes) => void }) {
  if (!notes.pins.length) return null;
  return (
    <ul className="flex max-h-28 flex-col gap-1 overflow-y-auto">
      {notes.pins.map((note) => (
        <NoteChip
          key={note.id}
          note={note}
          number={markerNumber(notes.pins, note)}
          onChange={onNotes && ((text) => onNotes({ ...notes, pins: notes.pins.map((each) => (each.id === note.id ? { ...each, text } : each)) }))}
          onRemove={onNotes && (() => onNotes({ ...notes, pins: notes.pins.filter((each) => each.id !== note.id) }))}
        />
      ))}
    </ul>
  );
}

export function Tray({
  notes,
  onNotes,
  send,
  round,
  hint,
  confirm,
  stopped,
  older,
  built,
  answered,
  onSend,
  onBuild,
  onCancel,
  onNewest,
  onEarlier,
  onReal,
  onReview,
}: {
  notes: Notes;
  onNotes: (notes: Notes) => void;
  send: Send;
  /** The round the notes start: the newest's next. */
  round: number;
  /** The line with no notes yet. */
  hint: string | null;
  /** Use's confirm: the picked variant and the others, whose code goes. */
  confirm: { letter: string; others: string[] } | null;
  stopped: boolean;
  /** An older round shown, read-only: its number. */
  older: number | null;
  /** The picked variant, once built into the app. */
  built: string | null;
  /** How many notes the newest round took up, from the round before. */
  answered: number;
  onSend: () => void;
  onBuild: () => void;
  onCancel: () => void;
  onNewest: () => void;
  onEarlier: () => void;
  onReal: () => void;
  onReview: () => void;
}) {
  const unsent = noteCount(notes);
  const keys = <Kbd variant="chip">{keysOf("mockup-send")[0]}</Kbd>;
  let body: ReactNode;
  if (built) {
    body = (
      <div className={LINE}>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{built} is built into the app.</span>
        <Button variant="link-blue" size="inline" onClick={onReview}>
          Open in Review
        </Button>
        <Button variant="soft" size="xs" onClick={onReal}>
          Open the real screen
        </Button>
      </div>
    );
  } else if (confirm) {
    const gone = confirm.others.length ? ` ${confirm.others.join(" and ")} ${confirm.others.length === 1 ? "is" : "are"} deleted.` : "";
    const how = stopped ? `Your session wires ${confirm.letter}'s code into the app.` : `Keeps ${confirm.letter}'s code and wires it into the app.`;
    const going = unsent ? ` ${unsent === 1 ? "1 unsent note goes" : `${unsent} unsent notes go`} with it.` : "";
    body = (
      <>
        <div className={LINE}>
          <b className="shrink-0">Build {confirm.letter} for real?</b>
          <span className="min-w-0 truncate text-muted-foreground">{how + gone + going}</span>
        </div>
        <NoteList notes={notes} onNotes={onNotes} />
        <div className={LINE}>
          <span className="flex-1" />
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={onBuild}>
            Build {confirm.letter} {keys}
          </Button>
        </div>
      </>
    );
  } else if (older !== null) {
    body = (
      <div className={LINE}>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">Round {older}, as it was. Its notes went with round {older + 1}.</span>
        <Button variant="link-blue" size="inline" onClick={onNewest}>
          Show the newest
        </Button>
      </div>
    );
  } else if (stopped) {
    body = (
      <>
        <span className="text-muted-foreground">This mockup’s worker was stopped. Notes can’t be sent.</span>
        <NoteList notes={notes} onNotes={onNotes} />
      </>
    );
  } else {
    const label = send === "failed" ? "Couldn’t send · Retry" : send === "sending" ? "Sending…" : unsent ? `Send ${count(unsent)}` : "Send notes";
    body = (
      <>
        {notes.pins.length > 0 && <span className="text-2xs tracking-wide text-muted-foreground uppercase">{count(unsent)} for round {round}</span>}
        <NoteList notes={notes} onNotes={send === "sending" ? undefined : onNotes} />
        <div className={LINE}>
          {!notes.pins.length && answered > 0 && (
            <>
              <span className="shrink-0 text-muted-foreground">Round {round - 1} answered {count(answered)}.</span>
              <Button variant="link-blue" size="inline" onClick={onEarlier}>
                See them
              </Button>
            </>
          )}
          {!notes.pins.length && !answered && hint && <span className="min-w-0 truncate text-muted-foreground">{hint}</span>}
          <span className="flex-1" />
          <div className="w-56 min-w-0 shrink">
            <Input
              aria-label="Note for all variants"
              placeholder="Note for all variants…"
              value={notes.all}
              disabled={send === "sending"}
              onValueChange={(all) => onNotes({ ...notes, all })}
            />
          </div>
          <Button variant={send === "failed" ? "soft-destructive" : "default"} size="sm" disabled={!unsent || send === "sending"} onClick={onSend}>
            {label} {send !== "sending" && keys}
          </Button>
        </div>
      </>
    );
  }
  return <div className="flex shrink-0 flex-col gap-1.5 border-t border-divider bg-background px-3 py-2 text-sm">{body}</div>;
}
