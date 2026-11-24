import { $getLexicalContent, $insertDataTransferForRichText } from "@lexical/clipboard";
import { $getSelection, $isRangeSelection, type LexicalEditor } from "lexical";

import { $isChipNode, ChipNode } from "./chip";

/** A file added to the message: `inText`, its chip is in the text (an image, a long paste); otherwise a tile. */
export type AttachFn = (id: string, file: File, inText: boolean) => void;

export const NAMESPACE = "composer";
const LEXICAL = "application/x-lexical-editor";

/**
 * Copy and cut also put the selection's nodes on the clipboard when it holds a chip (the plain-text field
 * copies text only); a paste of them in a composer brings the chips back, ids and all.
 */
export function copyChips(editor: LexicalEditor, event: ClipboardEvent | KeyboardEvent | null): false {
  const selection = $getSelection();
  const data = event instanceof ClipboardEvent ? event.clipboardData : null;
  if (data && $isRangeSelection(selection) && selection.getNodes().some($isChipNode)) {
    const json = $getLexicalContent(editor);
    if (json) data.setData(LEXICAL, json);
  }
  // The plain-text field still writes the text itself.
  return false;
}
export function pasteChips(editor: LexicalEditor, event: ClipboardEvent | InputEvent | KeyboardEvent): boolean {
  const data = event instanceof ClipboardEvent ? event.clipboardData : null;
  const selection = $getSelection();
  const json = data?.getData(LEXICAL);
  if (!data || !json || !$isRangeSelection(selection)) return false;
  try {
    // Only another composer's nodes: a rich editor's (headings, lists) don't belong in this field.
    if ((JSON.parse(json) as { namespace?: string }).namespace !== NAMESPACE) return false;
  } catch {
    return false;
  }
  event.preventDefault();
  $insertDataTransferForRichText(data, selection, editor);
  return true;
}

/** Plain text this long, pasted, goes in as a "Pasted text" chip instead of as text. */
const PASTE_CHIP_CHARS = 800;

/**
 * A paste of files or of long text: an image goes in at the caret as a chip, any other file beside the text
 * (`onAttach` with `inText` false), long text as a "Pasted text" chip. Each gets its id here, at once.
 */
export function pasteAttachments(event: ClipboardEvent | InputEvent | KeyboardEvent, onAttach: AttachFn | undefined): boolean {
  const data = event instanceof ClipboardEvent ? event.clipboardData : null;
  const selection = $getSelection();
  if (!onAttach || !data || !$isRangeSelection(selection)) return false;
  const files = [...data.files];
  const text = data.getData("text/plain");
  if (files.length === 0 && text.length < PASTE_CHIP_CHARS) return false;
  event.preventDefault();
  const added: [string, File, boolean][] = [];
  const chips: ChipNode[] = [];
  const add = (file: File, kind: "image" | "paste" | null) => {
    const id = crypto.randomUUID();
    added.push([id, file, kind !== null]);
    if (kind === "paste") chips.push(new ChipNode({ kind, attachmentId: id, preview: text.trim().replace(/\s+/g, " ").slice(0, 80) }));
    else if (kind) chips.push(new ChipNode({ kind, attachmentId: id }));
  };
  if (files.length > 0) for (const file of files) add(file, file.type.startsWith("image/") ? "image" : null);
  else add(new File([text], "Pasted text.txt", { type: "text/plain" }), "paste");
  if (chips.length > 0) selection.insertNodes(chips);
  // Out of the editor's update: the caller's state changes there.
  queueMicrotask(() => added.forEach((each) => onAttach(...each)));
  return true;
}
