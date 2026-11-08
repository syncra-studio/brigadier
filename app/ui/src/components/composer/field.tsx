import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { $getLexicalContent, $insertDataTransferForRichText } from "@lexical/clipboard";
import { mergeRegister } from "@lexical/utils";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  COMMAND_PRIORITY_NORMAL,
  COPY_COMMAND,
  CUT_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  type LexicalEditor,
  PASTE_COMMAND,
} from "lexical";
import { type Ref, useEffect, useEffectEvent, useImperativeHandle, useRef, useState } from "react";

import { cx } from "../cx";
import { type Attachment, AttachmentsContext, ChipNumbers } from "./attachments";
import { $isChipNode, ChipNode } from "./chip";
import { type Draft, EMPTY_DRAFT, isEmpty } from "./draft";
import { CommandHighlight } from "./command-highlight";
import { type Commands, MentionPlugin, type Mentions, SlashPlugin } from "./menus";

type Parts = Draft["parts"];

/** What feature code does with the field: read what's typed, show another draft's text, focus it. */
export type ComposerFieldHandle = {
  parts(): Parts;
  /** Shows `parts` in place of what's there (a pulled queued message, an emptied field after a send). */
  set(parts: Parts): void;
  focus(): void;
};

// The composer's field grows to a quarter of the window, then scrolls; the edit box to its bubble's limit.
const SIZES = {
  composer: { box: "max-h-composer-max", pad: "min-h-composer px-2 py-2.5" },
  edit: { box: "max-h-user-message", pad: "min-h-composer px-2 py-1" },
};

const MAC = navigator.userAgent.includes("Mac");

/** ⏎ sends, ⌥⏎ (and ⌘⏎) send the other way, ⇧⏎ is a new line; Ctrl on a Mac (the Windows key elsewhere) isn't ours. */
function enterAction(event: KeyboardEvent): "send" | "other" | null {
  if ((MAC ? event.ctrlKey : event.metaKey) || event.shiftKey) return null;
  const mod = MAC ? event.metaKey : event.ctrlKey;
  if (event.altKey) return mod ? null : "other";
  return mod ? "other" : "send";
}

function $read(): Parts {
  const parts: Parts = [];
  const add = (text: string) => {
    const last = parts.length - 1;
    if (typeof parts[last] === "string") parts[last] += text;
    else if (text) parts.push(text);
  };
  $getRoot()
    .getChildren()
    .forEach((block, at) => {
      if (at > 0) add("\n");
      if (!$isElementNode(block)) return;
      for (const node of block.getChildren()) {
        if ($isChipNode(node)) parts.push(node.__chip);
        else add($isLineBreakNode(node) ? "\n" : node.getTextContent());
      }
    });
  return parts;
}

/** `select`: the caret goes to the end (which also focuses the field), as for a recalled prompt; not on mount. */
function $write(parts: Parts, select = true): void {
  const paragraph = $createParagraphNode();
  for (const part of parts) {
    if (typeof part !== "string") {
      paragraph.append(new ChipNode(part));
      continue;
    }
    part.split("\n").forEach((line, at) => {
      if (at > 0) paragraph.append($createLineBreakNode());
      if (line) paragraph.append($createTextNode(line));
    });
  }
  $getRoot().clear().append(paragraph);
  if (select) paragraph.selectEnd();
}

const NAMESPACE = "composer";
const LEXICAL = "application/x-lexical-editor";

/**
 * Copy and cut also put the selection's nodes on the clipboard when it holds a chip (the plain-text field
 * copies text only); a paste of them in a composer brings the chips back, ids and all.
 */
function copyChips(editor: LexicalEditor, event: ClipboardEvent | KeyboardEvent | null): false {
  const selection = $getSelection();
  const data = event instanceof ClipboardEvent ? event.clipboardData : null;
  if (data && $isRangeSelection(selection) && selection.getNodes().some($isChipNode)) {
    const json = $getLexicalContent(editor);
    if (json) data.setData(LEXICAL, json);
  }
  // The plain-text field still writes the text itself.
  return false;
}
function pasteChips(editor: LexicalEditor, event: ClipboardEvent | InputEvent | KeyboardEvent): boolean {
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
const PASTE_CHIP_CHARS = 2000;

/**
 * A paste of files or of long text: an image goes in at the caret as a chip, any other file beside the text
 * (`onAttach` with `inText` false), long text as a "Pasted text" chip. Each gets its id here, at once.
 */
function pasteAttachments(event: ClipboardEvent | InputEvent | KeyboardEvent, onAttach: AttachFn | undefined): boolean {
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

/** Each image's and pasted text's number in the text ("Image #2"), in order. */
function numbersOf(parts: Parts): Map<string, number> {
  const numbers = new Map<string, number>();
  const count = { image: 0, paste: 0 };
  // A copied chip keeps its id: it keeps the first copy's number.
  for (const part of parts) if (typeof part !== "string" && part.kind !== "mention" && !numbers.has(part.attachmentId)) numbers.set(part.attachmentId, ++count[part.kind]);
  return numbers;
}
const sameNumbers = (a: Map<string, number>, b: Map<string, number>) => a.size === b.size && [...a].every(([id, n]) => b.get(id) === n);

const NO_ATTACHMENTS: ReadonlyMap<string, Attachment> = new Map();

const blank = (parts: Parts) => isEmpty({ parts, attachmentIds: [] });

/** A file added to the message: `inText`, its chip is in the text (an image, a long paste); otherwise a tile. */
type AttachFn = (id: string, file: File, inText: boolean) => void;

type FieldProps = {
  ref?: Ref<ComposerFieldHandle>;
  /** Read once, as the field mounts: give it a new `key` for another session's draft. */
  initial?: Draft;
  placeholder: string;
  label?: string;
  size?: keyof typeof SIZES;
  /** Takes the keyboard as it mounts, unless the user is already somewhere else. */
  autoFocus?: boolean;
  /** The session's sent prompts, oldest first: ↑ in an empty field walks back through them, ↓ forward. */
  prompts?: Draft[];
  onChange?: (parts: Parts) => void;
  /** Enter: `other` when ⌥ (or ⌘) asked for the other way. Without it Enter is a new line. */
  onSubmit?: (other: boolean) => void;
  /** Esc in the field; without it Esc is left to the page (the send button's stop). */
  onEscape?: () => void;
  /** ↑ in an empty field, before the prompts: pulls the last queued message back; true when it did. */
  onPullQueued?: () => boolean;
  /** The `@` menu's results; without it `@` is plain text. */
  mentions?: Mentions;
  /** The `/` menu's commands; without it `/` is plain text. */
  commands?: Commands;
  /** Pasted files and long text; without it a paste is text only. */
  onAttach?: AttachFn;
  /** What the chips' images and pasted texts show (their thumbnails, names, states), by id. */
  attachments?: ReadonlyMap<string, Attachment>;
};

/**
 * The composer's text field (Lexical, plain text): grows with its text, then scrolls, the top line fading
 * under the edge once scrolled. Mentions, images and long pastes sit in the text as chips (`Draft`).
 */
export function ComposerField({
  initial = EMPTY_DRAFT,
  placeholder,
  label = "Message input",
  size = "composer",
  mentions,
  commands,
  attachments = NO_ATTACHMENTS,
  ...props
}: FieldProps) {
  const [scrolled, setScrolled] = useState(false);
  const [numbers, setNumbers] = useState(() => numbersOf(initial.parts));
  const { box, pad } = SIZES[size];
  const onChange = (parts: Parts) => {
    const next = numbersOf(parts);
    setNumbers((now) => (sameNumbers(now, next) ? now : next));
    props.onChange?.(parts);
  };
  return (
    <AttachmentsContext value={attachments}>
    <ChipNumbers value={numbers}>
    <LexicalComposer
      initialConfig={{
        namespace: NAMESPACE,
        nodes: [ChipNode],
        editorState: () => $write(initial.parts, false),
        onError: (error) => console.error("[composer]", error),
      }}
    >
      <div
        data-slot="composer-field"
        data-scrolled={scrolled || undefined}
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
        className={cx("relative w-full cursor-text overflow-y-auto text-base data-scrolled:mask-fade-top", box)}
      >
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              aria-label={label}
              aria-placeholder={placeholder}
              placeholder={<div className={cx("pointer-events-none absolute inset-0 truncate text-placeholder select-none", pad)}>{placeholder}</div>}
              className={cx("break-words whitespace-pre-wrap caret-primary outline-none", pad)}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <HistoryPlugin />
      <Keys {...props} onChange={onChange} />
      {mentions && <MentionPlugin {...mentions} />}
      {commands && <SlashPlugin {...commands} />}
      {commands && <CommandHighlight commands={commands.commands} />}
    </LexicalComposer>
    </ChipNumbers>
    </AttachmentsContext>
  );
}

function Keys({
  ref,
  autoFocus,
  prompts = [],
  onChange,
  onSubmit,
  onEscape,
  onPullQueued,
  onAttach,
}: Omit<FieldProps, "initial" | "placeholder" | "label" | "size" | "mentions" | "commands" | "attachments">) {
  const [editor] = useLexicalComposerContext();
  // How far back ↑ has walked, and the text it showed: typing anything else ends the walk.
  const walk = useRef<{ back: number; shown: string } | null>(null);
  const changed = useEffectEvent((parts: Parts) => onChange?.(parts));
  const paste = useEffectEvent((event: ClipboardEvent | InputEvent | KeyboardEvent) => pasteChips(editor, event) || pasteAttachments(event, onAttach));
  const submit = useEffectEvent((event: KeyboardEvent | null) => {
    if (!event || event.isComposing || !onSubmit) return false;
    const action = enterAction(event);
    if (!action) return false;
    event.preventDefault();
    onSubmit(action === "other");
    return true;
  });
  const escape = useEffectEvent((event: KeyboardEvent) => {
    if (!onEscape) return false;
    event.preventDefault();
    onEscape();
    return true;
  });
  const recall = useEffectEvent((event: KeyboardEvent, up: boolean) => {
    if (event.isComposing) return false;
    const now = $read();
    if (walk.current && JSON.stringify(now) !== walk.current.shown) walk.current = null;
    if (!walk.current) {
      if (!up || !blank(now)) return false;
      if (onPullQueued?.()) {
        event.preventDefault();
        return true;
      }
    }
    const back = (walk.current?.back ?? -1) + (up ? 1 : -1);
    if (back >= prompts.length) return prompts.length > 0;
    $write(back < 0 ? [] : prompts[prompts.length - 1 - back]!.parts);
    walk.current = back < 0 ? null : { back, shown: JSON.stringify($read()) };
    event.preventDefault();
    return true;
  });

  useImperativeHandle(
    ref,
    () => ({
      parts: () => editor.read($read),
      set: (parts) => editor.update(() => $write(parts)),
      focus: () => editor.focus(),
    }),
    [editor],
  );

  useEffect(() => {
    // Not over the user's place elsewhere: another field, or anything in a dialog.
    const active = document.activeElement;
    if (autoFocus && !active?.matches("input, textarea, select, [contenteditable=true], [role=dialog] *")) editor.focus();
    // Only as it mounts: `autoFocus` is read once.
  }, [editor]);

  useEffect(
    () =>
      mergeRegister(
        editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
          if (dirtyElements.size > 0 || dirtyLeaves.size > 0) changed(editorState.read($read));
        }),
        editor.registerCommand(COPY_COMMAND, (event) => copyChips(editor, event), COMMAND_PRIORITY_NORMAL),
        editor.registerCommand(CUT_COMMAND, (event) => copyChips(editor, event), COMMAND_PRIORITY_NORMAL),
        editor.registerCommand(PASTE_COMMAND, paste, COMMAND_PRIORITY_NORMAL),
        // Enter and Space on a chip's own button (its ✕, reached by Tab) press it rather than send.
        editor.registerCommand(KEY_DOWN_COMMAND, (event) => (event.key === "Enter" || event.key === " ") && event.target instanceof HTMLButtonElement, COMMAND_PRIORITY_NORMAL),
        editor.registerCommand(KEY_ENTER_COMMAND, submit, COMMAND_PRIORITY_NORMAL),
        editor.registerCommand(KEY_ESCAPE_COMMAND, escape, COMMAND_PRIORITY_NORMAL),
        editor.registerCommand(KEY_ARROW_UP_COMMAND, (event) => recall(event, true), COMMAND_PRIORITY_NORMAL),
        editor.registerCommand(KEY_ARROW_DOWN_COMMAND, (event) => recall(event, false), COMMAND_PRIORITY_NORMAL),
      ),
    [editor],
  );
  return null;
}
