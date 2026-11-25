import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { $createListItemNode, $createListNode, $isListItemNode, $isListNode, ListItemNode, ListNode } from "@lexical/list";
import { mergeRegister } from "@lexical/utils";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $addUpdateTag,
  $createTextNode,
  $getRoot,
  $getSelection,
  $hasUpdateTag,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  COMMAND_PRIORITY_NORMAL,
  type ElementNode,
  COPY_COMMAND,
  CUT_COMMAND,
  INSERT_LINE_BREAK_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  type LexicalEditor,
  LineBreakNode,
  PASTE_COMMAND,
  type RangeSelection,
  TextNode,
} from "lexical";
import { type Ref, type RefObject, useEffect, useEffectEvent, useImperativeHandle, useMemo, useRef, useState } from "react";

import { Terminal } from "../../icons/thread";
import { matches } from "../../shortcuts";
import { cx } from "../cx";
import { type AttachFn, copyChips, NAMESPACE, pasteAttachments, pasteChips } from "./clipboard";
import { type Attachment, AttachmentsContext, ChipNumbers } from "./attachments";
import { $insertChip, $isChipNode, ChipContext, ChipNode, type OpenKind } from "./chip";
import { type Chip, type Draft, EMPTY_DRAFT, isEmpty, plainText } from "./draft";
import { CommandChips } from "./command-chips";
import { asShell, asWords, bare, isShell } from "./shell";
import { registerArrowKeys } from "./arrow-keys";
import { $caretItem, ITEM, MarkdownKeys, UrlNode } from "./markdown-keys";
import { OVERLAYS } from "./decision-parts";
import { type Commands, MentionPlugin, type Mentions, SlashPlugin } from "./menus";

type Parts = Draft["parts"];

/** What feature code does with the field: read what's typed, show another draft's text, put a chip in, focus it. */
export type ComposerFieldHandle = {
  parts(): Parts;
  /** Shows `parts` in place of what's there (a pulled queued message, an emptied field after a send). */
  set(parts: Parts): void;
  insert(chip: Chip): void;
  focus(): void;
};

// The composer's field grows to a quarter of the window, then scrolls; a question
// card's answer to 8rem, a line tall at first; an approval's reason stays one line and slides sideways.
const SIZES = {
  composer: { box: "max-h-composer-max text-base", pad: "min-h-composer px-2 py-2.5" },
  card: { box: "max-h-32 text-code", pad: "min-h-5" },
  line: { box: "h-5 text-code", pad: "min-h-5" },
};

/** ⏎ sends, ⌘⏎ (and ⌥⏎) send the other way, ⌥⌘⏎ starts it as a new session [D183]; ⇧⏎ is the field's new line. */
function enterAction(event: KeyboardEvent): "send" | "other" | "new" | null {
  return matches(event, "send") ? "send" : matches(event, "follow-up-other") ? "other" : matches(event, "start-new") ? "new" : null;
}

/** What's typed, a drawn list as Markdown: `- item`, `1. item`, a nested one indented under its item's text. */
function $read(): Parts {
  const parts: Parts = [];
  const add = (text: string) => {
    const last = parts.length - 1;
    if (typeof parts[last] === "string") parts[last] += text;
    else if (text) parts.push(text);
  };
  let first = true;
  const line = (prefix: string, block: ElementNode) => {
    if (!first) add("\n");
    first = false;
    add(prefix);
    for (const node of block.getChildren()) {
      if ($isChipNode(node)) parts.push(node.__chip);
      else add($isLineBreakNode(node) ? "\n" : node.getTextContent());
    }
  };
  const list = (node: ListNode, indent: string) => {
    let number = node.getStart();
    let width = 2;
    for (const item of node.getChildren().filter($isListItemNode)) {
      // An item holding only a list is the one above's nested list.
      const nested = item.getFirstChild();
      if ($isListNode(nested)) {
        list(nested, indent + " ".repeat(width));
        continue;
      }
      const marker = node.getListType() === "number" ? `${number++}. ` : "- ";
      width = marker.length;
      line(indent + marker, item);
    }
  };
  for (const block of $getRoot().getChildren()) {
    if ($isListNode(block)) list(block, "");
    else if ($isElementNode(block)) {
      // A line straight after a list reads in Markdown as its last item going on: a blank line ends the list.
      if ($isListNode(block.getPreviousSibling()) && !block.isEmpty()) add("\n");
      line("", block);
    }
  }
  return parts;
}

/** `select`: the caret goes to the end (which also focuses the field), as for a recalled prompt; not on mount. */
function $write(parts: Parts, select = true): void {
  const root = $getRoot().clear();
  const lines: Parts[] = [[]];
  for (const part of parts) {
    if (typeof part !== "string") lines.at(-1)!.push(part);
    else
      part.split("\n").forEach((text, at) => {
        if (at > 0) lines.push([]);
        if (text) lines.at(-1)!.push(text);
      });
  }
  // Markdown list lines come back drawn, nested by their indents (`indents`: the open lists' depths).
  let indents: number[] = [];
  const isItem = (line?: Parts) => typeof line?.[0] === "string" && ITEM.test(line[0]);
  for (const [at, line] of lines.entries()) {
    // The blank line $read puts between a list and the line after it.
    if (line.length === 0 && indents.length > 0 && lines[at + 1]?.length && !isItem(lines[at + 1])) continue;
    const item = typeof line[0] === "string" ? ITEM.exec(line[0]) : null;
    let block: ElementNode;
    if (!item) {
      indents = [];
      root.append((block = $createParagraphNode()));
    } else {
      line[0] = (line[0] as string).slice(item[0].length);
      const indent = item[1]!.length;
      const type = item[3] ? "number" : "bullet";
      while (indents.length > 0 && indents.at(-1)! > indent) indents.pop();
      if (indents.length === 0 || indents.at(-1)! < indent) indents.push(indent);
      const last = root.getLastChild();
      const list = $isListNode(last) && !(indents.length === 1 && last.getListType() !== type) ? last : $createListNode(type, Number(item[3] ?? 1));
      if (list !== last) root.append(list);
      const node = $createListItemNode();
      list.append(node);
      node.setIndent(indents.length - 1);
      const parent = node.getParent();
      if ($isListNode(parent) && parent.getListType() !== type) parent.setListType(type);
      block = node;
    }
    for (const part of line) {
      if (typeof part !== "string") block.append(new ChipNode(part));
      else if (part) block.append($createTextNode(part));
    }
  }
  if (select) root.selectEnd();
}

// The note's list look (note/page.css).
const THEME = { list: { ul: "m-0 ps-6 list-disc", ol: "m-0 ps-6 list-decimal", nested: { listitem: "list-none" } } };

/** Each image's and pasted text's number in the text ("Image #2"), in order. */
export function numbersOf(parts: Parts): Map<string, number> {
  const numbers = new Map<string, number>();
  const count = { image: 0, paste: 0 };
  // A copied chip keeps its id: it keeps the first copy's number.
  for (const part of parts) {
    if (typeof part !== "string" && (part.kind === "image" || part.kind === "paste") && !numbers.has(part.attachmentId)) numbers.set(part.attachmentId, ++count[part.kind]);
  }
  return numbers;
}
const sameNumbers = (a: Map<string, number>, b: Map<string, number>) => a.size === b.size && [...a].every(([id, n]) => b.get(id) === n);

const NO_ATTACHMENTS: ReadonlyMap<string, Attachment> = new Map();

/** An update that sets the field whole, its mode decided. */
const SET = "composer-set";
const blank = (parts: Parts) => isEmpty({ parts, attachmentIds: [] });

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
  /** ⌥⌘⏎: start the message as a new session; without it ⌥⌘⏎ does nothing. */
  onSubmitNew?: () => void;
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
  /** A click on a chip: opens what it names (a mention's id, a command's id, an attachment's id). */
  onOpen?: (kind: OpenKind, id: string) => void;
  /** `!` first makes it a shell command here [D316]: the `!` becomes the mode, in what's read, set and kept alone. Esc,
   * Backspace or Ctrl+U in an empty one leaves it. */
  shell?: boolean;
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
  onOpen,
  ...props
}: FieldProps) {
  const [scrolled, setScrolled] = useState(false);
  const [numbers, setNumbers] = useState(() => numbersOf(initial.parts));
  // The ref is the mode as the editor's own updates read it; the state draws it.
  const mode = useRef(props.shell === true && isShell(initial.parts));
  const [drawn, setDrawn] = useState(mode.current);
  const setMode = (on: boolean) => ((mode.current = on), setDrawn(on));
  const bang = drawn && props.shell === true;
  const words = bang ? "Run a command" : placeholder;
  const { box, pad } = SIZES[size];
  // A one-line field stays plain text; the others draw lists.
  const TextPlugin = size === "line" ? PlainTextPlugin : RichTextPlugin;
  const list = commands?.commands;
  const chips = useMemo(() => ({ onOpen, commands: new Map((list ?? []).map((command) => [command.id, command])) }), [onOpen, list]);
  const onChange = (parts: Parts) => {
    const next = numbersOf(parts);
    setNumbers((now) => (sameNumbers(now, next) ? now : next));
    props.onChange?.(parts);
  };
  return (
    <AttachmentsContext value={attachments}>
    <ChipNumbers value={numbers}>
    <ChipContext value={chips}>
    <LexicalComposer
      initialConfig={{
        namespace: NAMESPACE,
        nodes: [ChipNode, UrlNode, ListNode, ListItemNode],
        theme: THEME,
        editorState: () => $write(mode.current ? bare(initial.parts) : initial.parts, false),
        onError: (error) => console.error("[composer]", error),
      }}
    >
      <div
        data-slot="composer-field"
        data-scrolled={scrolled || undefined}
        data-shell={bang || undefined}
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
        className={cx("relative w-full cursor-text data-shell:ps-7 data-shell:font-mono", size === "line" ? "overflow-hidden" : "scroll-gutter overflow-y-auto data-scrolled:mask-fade-top", box)}
      >
        {bang && <Terminal className="absolute start-2 top-3 size-icon-md text-link" />}
        <TextPlugin
          contentEditable={
            // Lexical sets white-space inline, so a line's no-wrap has to be important.
            <ContentEditable
              aria-label={bang ? "Shell command input" : label}
              aria-placeholder={words}
              placeholder={<div className={cx("pointer-events-none absolute inset-0 truncate text-placeholder select-none", bang && "ps-9", pad)}>{words}</div>}
              className={cx("caret-primary outline-none", size === "line" ? "whitespace-pre!" : "break-words whitespace-pre-wrap", pad)}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <HistoryPlugin />
      {size === "line" ? <OneLine /> : !bang && <MarkdownKeys />}
      <Keys {...props} size={size} onChange={onChange} mode={mode} setMode={setMode} />
      {mentions && !bang && <MentionPlugin {...mentions} />}
      {commands && !bang && <SlashPlugin {...commands} />}
      {commands && !bang && <CommandChips commands={commands.commands} />}
    </LexicalComposer>
    </ChipContext>
    </ChipNumbers>
    </AttachmentsContext>
  );
}

/** Keeps a field to one line: no line breaks, any newline that gets in becomes a space, and it follows the caret sideways (Lexical only scrolls up and down). */
function OneLine() {
  const [editor] = useLexicalComposerContext();
  useEffect(
    () =>
      mergeRegister(
        editor.registerCommand(INSERT_LINE_BREAK_COMMAND, () => true, COMMAND_PRIORITY_NORMAL),
        editor.registerCommand(INSERT_PARAGRAPH_COMMAND, () => true, COMMAND_PRIORITY_NORMAL),
        editor.registerNodeTransform(LineBreakNode, (node) => void node.replace($createTextNode(" "))),
        editor.registerUpdateListener(() => {
          const root = editor.getRootElement();
          const box = root?.parentElement;
          const selection = root?.ownerDocument.getSelection();
          if (!root || !box || !selection?.rangeCount || !root.contains(selection.focusNode)) return;
          const caret = selection.getRangeAt(0).getBoundingClientRect();
          // An empty line has no caret box; the scroll is back at 0 by itself.
          if (caret.height === 0) return;
          const shown = box.getBoundingClientRect();
          if (caret.right > shown.right) box.scrollLeft += caret.right - shown.right + 2;
          else if (caret.left < shown.left) box.scrollLeft -= shown.left - caret.left;
        }),
      ),
    [editor],
  );
  return null;
}

function Keys({
  ref,
  size,
  autoFocus,
  prompts = [],
  onChange,
  onSubmit,
  onSubmitNew,
  onEscape,
  onPullQueued,
  onAttach,
  shell = false,
  mode,
  setMode,
}: Omit<FieldProps, "initial" | "placeholder" | "label" | "mentions" | "commands" | "attachments" | "onOpen"> & { mode: RefObject<boolean>; setMode: (on: boolean) => void }) {
  const [editor] = useLexicalComposerContext();
  // How far back ↑ has walked, and the text it showed: typing anything else ends the walk.
  const walk = useRef<{ back: number; shown: string } | null>(null);
  const caret = useRef<RangeSelection | null>(null); // the field's last caret, for a pick from the +, which takes the focus
  // What's typed, a command's with its `!`.
  const read = () => (!shell ? $read() : mode.current ? asShell($read()) : asWords($read()));
  const changed = useEffectEvent(() => onChange?.(editor.getEditorState().read(read)));
  const write = (parts: Parts, select = true) => {
    $addUpdateTag(SET);
    setMode(shell && isShell(parts));
    $write(mode.current ? bare(parts) : parts, select);
  };
  // A command takes pasted words alone, and one pasted whole is it however long.
  const paste = useEffectEvent((event: ClipboardEvent | InputEvent | KeyboardEvent) => {
    const whole = shell && blank($read()) && event instanceof ClipboardEvent && event.clipboardData?.getData("text/plain").startsWith("!");
    return !mode.current && !whole && (pasteChips(editor, event) || pasteAttachments(event, onAttach));
  });
  /** `!` first in an empty field is taken as the mode. */
  const enter = useEffectEvent((node: TextNode) => {
    if (!shell || mode.current || !node.isSimpleText() || $getRoot().getFirstDescendant() !== node || !isShell($read())) return;
    if ($hasUpdateTag(SET) || !(plainText($read()) === "!" || editor.getEditorState().read(() => blank($read())))) return;
    node.splitText(1)[0]!.remove();
    setMode(true);
  });
  const leave = useEffectEvent((event: KeyboardEvent) => {
    if (!mode.current || $getRoot().getTextContent()) return false;
    event.preventDefault();
    setMode(false);
    queueMicrotask(changed);
    return true;
  });
  const submit = useEffectEvent((event: KeyboardEvent | null) => {
    if (!event || event.isComposing || !onSubmit) return false;
    const action = enterAction(event);
    // ⏎ in a list adds an item; ⌘⏎ still sends.
    if (!action || (action === "new" && !onSubmitNew) || (action === "send" && $caretItem())) return false;
    event.preventDefault();
    // A held Enter is one press: it can't send twice or answer the next card.
    if (event.repeat) return true;
    if (action === "new") onSubmitNew?.();
    else onSubmit(action === "other");
    return true;
  });
  const escape = useEffectEvent((event: KeyboardEvent) => {
    // In a command Esc never reaches the agent's Stop.
    if (mode.current) return event.preventDefault(), leave(event), true;
    if (!onEscape) return false;
    event.preventDefault();
    onEscape();
    return true;
  });
  const recall = useEffectEvent((event: KeyboardEvent, up: boolean) => {
    if (!matches(event, "history")) return false;
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
    write(back < 0 ? [] : prompts[prompts.length - 1 - back]!.parts);
    walk.current = back < 0 ? null : { back, shown: JSON.stringify($read()) };
    event.preventDefault();
    return true;
  });

  useImperativeHandle(
    ref,
    () => ({
      parts: () => editor.read(read),
      set: (parts) => editor.update(() => write(parts)),
      insert: (chip) => editor.update(() => $insertChip(chip, caret.current)),
      focus: () => editor.focus(),
    }),
    [editor, shell],
  );

  // Where commands stop being offered (a To: picked), its words are a message again.
  useEffect(() => {
    if (!shell && mode.current) editor.update(() => $write(asShell($read())), { onUpdate: () => setMode(false) });
  }, [editor, shell]);

  useEffect(() => {
    // Not over the user's place elsewhere: another field, or anything in a dialog.
    const active = document.activeElement;
    if (autoFocus && !active?.matches("input, textarea, select, [contenteditable=true], [role=dialog] *")) editor.focus();
    // Only as it mounts: `autoFocus` is read once.
  }, [editor]);

  // Type-to-focus [D234]: a character or ⌘V with nothing editable focused and nothing open lands in the shown composer.
  // Space stays the thread's scroll key, a focused question card's numbers its answers.
  useEffect(() => {
    if (size !== "composer") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const root = editor.getRootElement();
      const paste = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "v";
      const char = event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey && !(matches(event, "answer") && document.activeElement?.closest("[data-action=question]"));
      if (!(char || paste) || event.defaultPrevented || event.isComposing || !root?.checkVisibility() || root.closest("[inert]")) return;
      // The model picker takes the letters typed in it [D92].
      if (document.activeElement?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false]), [data-slot=model-picker]:has(input)") || document.querySelector(OVERLAYS)) return;
      // At the draft's end, wherever the caret was left; focus() alone keeps the old selection.
      editor.update(() => $getRoot().selectEnd());
      editor.focus();
    };
    addEventListener("keydown", onKeyDown, true);
    return () => removeEventListener("keydown", onKeyDown, true);
  }, [editor, size]);

  useEffect(
    () =>
      mergeRegister(
        registerArrowKeys(editor),
        editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
          editorState.read(() => { const selection = $getSelection(); if ($isRangeSelection(selection)) caret.current = selection.clone(); });
          if (dirtyElements.size > 0 || dirtyLeaves.size > 0) changed();
        }),
        editor.registerCommand(COPY_COMMAND, (event) => copyChips(editor, event), COMMAND_PRIORITY_NORMAL),
        editor.registerCommand(CUT_COMMAND, (event) => copyChips(editor, event), COMMAND_PRIORITY_NORMAL),
        editor.registerCommand(PASTE_COMMAND, paste, COMMAND_PRIORITY_NORMAL),
        // Enter and Space on a chip's own button (its ✕, reached by Tab) press it rather than send.
        editor.registerCommand(KEY_DOWN_COMMAND, (event) => (event.key === "Enter" || event.key === " ") && event.target instanceof HTMLButtonElement, COMMAND_PRIORITY_NORMAL),
        editor.registerNodeTransform(TextNode, (node) => enter(node)),
        editor.registerCommand(KEY_BACKSPACE_COMMAND, leave, COMMAND_PRIORITY_NORMAL),
        editor.registerCommand(KEY_DOWN_COMMAND, (event) => event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "u" && leave(event), COMMAND_PRIORITY_NORMAL),
        editor.registerCommand(KEY_ENTER_COMMAND, submit, COMMAND_PRIORITY_NORMAL),
        editor.registerCommand(KEY_ESCAPE_COMMAND, escape, COMMAND_PRIORITY_NORMAL),
        editor.registerCommand(KEY_ARROW_UP_COMMAND, (event) => recall(event, true), COMMAND_PRIORITY_NORMAL),
        editor.registerCommand(KEY_ARROW_DOWN_COMMAND, (event) => recall(event, false), COMMAND_PRIORITY_NORMAL),
      ),
    [editor],
  );
  return null;
}
