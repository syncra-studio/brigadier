import { useEffect, useState } from "react";

import { Markdown } from "../thread/markdown";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { showToast } from "./toast";

/*
 * The old app's read-only reader (pasted-text.tsx's PastedTextDialog, read only): a sent text file or paste over the
 * thread, Markdown as the answers show it, other text as written. Which click opens what is its attachment-open.ts:
 * an image the viewer, text here, a file that would run a program nothing, anything else its default app [D2098].
 */

/** Source text that runs when launched: read here, never handed to the default app (the old launchTypes.json). */
const SCRIPTS = new Set("sh bash zsh csh tcsh ksh fish py pyw rb pl php lua tcl js mjs cjs ps1 bat cmd vbs applescript".split(" "));

type Reading = { title: string; url: string; markdown: boolean };
let showReader: ((reading: Reading) => void) | null = null;

/** One click on a sent file that isn't an image: the reader for text, else its default app unless it would run something. */
export function openSent(file: { name: string; mime: string; pasted?: boolean }, url: string, title = file.pasted ? "Pasted text" : file.name): void {
  const extension = /\.([^.\s]+)[.\s]*$/.exec(file.name)?.[1]?.toLowerCase() ?? "";
  if (file.pasted || file.mime.startsWith("text/") || file.mime === "application/json" || SCRIPTS.has(extension)) {
    return showReader?.({ title, url, markdown: file.mime === "text/markdown" });
  }
  void window.brigadier?.openAttachment(url).then((opened) => {
    if (!opened) showToast(`${file.name} wasn't opened: it could run a program on this Mac.`, { tone: "error" });
  });
}

/** Where `openSent` shows the reader: mounted once. */
export function ReaderHost() {
  const [reading, setReading] = useState<Reading | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    showReader = (next) => {
      setReading(next);
      setOpen(true);
    };
    return () => {
      showReader = null;
    };
  }, []);
  return <Reader reading={reading} open={open} onOpenChange={setOpen} />;
}

export function Reader({ reading, open, onOpenChange }: { reading: Reading | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent frame="max-h-9/10 max-w-reading grid-rows-reader gap-4 p-5" aria-describedby={undefined}>
        <DialogTitle className="truncate pe-6">{reading?.title}</DialogTitle>
        {/* Read afresh at each opening. */}
        {open && reading && <ReaderBody reading={reading} />}
      </DialogContent>
    </Dialog>
  );
}

function ReaderBody({ reading: { url, markdown } }: { reading: Reading }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void fetch(url)
      .then((response) => (response.ok ? response.text() : ""))
      .catch(() => "")
      .then((body) => live && setText(body));
    return () => {
      live = false;
    };
  }, [url]);
  return (
    <div data-slot="reader-body" className="min-h-0 overflow-y-auto select-text">
      {text !== null && (markdown ? <Markdown text={text} keep={url} /> : <p className="whitespace-pre-wrap wrap-anywhere">{text}</p>)}
    </div>
  );
}
