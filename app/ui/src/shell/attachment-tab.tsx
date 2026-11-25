import { useCallback, useEffect, useRef, useState } from "react";

import { ErrorLine } from "../components/error-line";
import { FileViewer } from "../files/viewer";
import type { FileRead } from "../files/types";
import { daemonRun } from "../session/composer";

/** How long typing rests before an edit is kept, as the old app's. */
const KEEP_AFTER_MS = 500;
/** The composer's pasted text: the label that opens editable while it's still the draft's. */
export const PASTE_LABEL = "Pasted text";
/** A PR's composer chip, a pasted text by its own name [D171]: "PR owner/name#n", or its repair's, "Merge conflicts – PR #n", "2 failing checks · build +1 more". */
export const PR_CHIP = /^PR \S*#\d+$|^(Merge conflicts|Review comments) – PR #\d+$|^\d+ failing checks? · /;
/** A chip that asks to repair a PR: its sent message is a "PR fix" [D171]. */
export const PR_FIX = /^(Merge conflicts|Review comments) – PR #\d+$|^\d+ failing checks? · /;
/** Whether a tab of this label is a pasted text: "Pasted text" or a PR's. */
export const isPasteLabel = (label: string) => label === PASTE_LABEL || PR_CHIP.test(label);

/**
 * An attachment in its own tab, as the old app opened a pasted text or a text file in one, and now every file that
 * isn't an image [D2098, D2104]: Rust reads it as the Files viewer reads a file and it shows there, read only; the
 * composer's pasted text, still unsent, is a page to edit it on instead.
 */
export function AttachmentTab({ owner, id, label, active }: { owner: string; id: string; label: string; active: boolean }) {
  const [read, setRead] = useState<FileRead>({ state: "loading" });
  const [sent, setSent] = useState(true);
  // Read again each time it's shown: meanwhile it may have been sent, edited or reconnected.
  useEffect(() => {
    if (!active) return;
    let live = true;
    void daemonRun(["attach", owner, "read", id]).then((reply) => {
      if (!live) return;
      if (!reply.ok) return setRead({ state: "failed", error: String(reply.error ?? "Couldn't read this file.") });
      setSent(reply.sent !== false);
      setRead(reply.file.gone ? { state: "gone", carried: false } : { state: "read", file: reply.file });
    });
    return () => {
      live = false;
    };
  }, [owner, id, active]);
  // A cut preview is never edited: saved, it would drop the rest.
  if (isPasteLabel(label) && !sent && read.state === "read" && read.file.text !== null && !read.file.truncated) return <PastePage owner={owner} id={id} label={label} text={read.file.text} active={active} />;
  return <FileViewer path={label} read={read} active={active} />;
}

/** The composer's pasted text as the old app's PastedTextView, kept under its id; sent or taken out, it says so [D2098]. */
function PastePage({ owner, id, label, text, active }: { owner: string; id: string; label: string; text: string; active: boolean }) {
  const save = (next: string) => daemonRun(["attach", owner, "write", id, next]).then((reply) => ({ ...reply, gone: String(reply.error).includes("no longer") }));
  return <KeptText label={label} text={text} active={active} save={save} gone="This pasted text is no longer in the message." />;
}

/**
 * Text edited in a tab and kept by Rust once typing rests, and as soon as the tab is left or closed. A save that
 * fails keeps the text and tries again with the next edit; one whose file is `gone` says so [D2098, D244].
 */
export function KeptText({ label, text, active, save, gone, placeholder }: { label: string; text: string; active: boolean; save: (text: string) => Promise<Record<string, any>>; gone?: string; placeholder?: string }) {
  const [state, setState] = useState<"gone" | { error: string } | null>(null);
  const pending = useRef<string | null>(null);
  const latest = useRef(text);
  // One write after another, so an older edit never lands over a newer one.
  const writes = useRef(Promise.resolve());
  const timer = useRef<number | undefined>(undefined);
  const saving = useRef(save);
  saving.current = save;
  const keep = useCallback(() => {
    window.clearTimeout(timer.current);
    const next = pending.current;
    if (next === null) return;
    pending.current = null;
    writes.current = writes.current.then(() =>
      saving.current(next).then((reply) => {
        if (reply.ok) return setState(null);
        if (reply.gone) return setState("gone");
        // Not kept: it goes with the next edit, or as the tab is left, unless a newer one went meanwhile.
        if (latest.current === next) pending.current ??= next;
        setState({ error: String(reply.error ?? "Couldn't keep this edit.") });
      }),
    );
  }, []);
  // Leaving the tab keeps the edit at once: Send, for one, is on the Chat tab [D2098].
  useEffect(() => {
    if (!active) keep();
  }, [active, keep]);
  useEffect(() => keep, [keep]);
  return (
    <div data-slot="kept-text" className="min-h-0 flex-1 overflow-y-auto px-5 pt-15 pb-32">
      <div className="mx-auto flex w-full max-w-184 flex-col gap-3">
        {state === "gone" ? (
          <p className="text-sm text-muted-foreground">{gone}</p>
        ) : (
          <>
            {state && <ErrorLine size="sm" error={state.error} />}
            <textarea
              aria-label={label}
              defaultValue={text}
              placeholder={placeholder}
              // A new note starts where it's typed.
              autoFocus={active && text === "" && placeholder !== undefined}
              spellCheck={false}
              onChange={(event) => {
                pending.current = latest.current = event.target.value;
                window.clearTimeout(timer.current);
                timer.current = window.setTimeout(keep, KEEP_AFTER_MS);
              }}
              // The ring sits a little outside the words, which keep their place.
              className="-m-2 block min-h-48 resize-none rounded-control bg-transparent p-2 text-plan whitespace-pre-wrap text-foreground caret-foreground outline-none field-sizing-content placeholder:text-placeholder focus-visible:focus-ring"
            />
          </>
        )}
      </div>
    </div>
  );
}
