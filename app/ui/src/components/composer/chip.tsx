import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isTextNode,
  $setSelection,
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type RangeSelection,
  type SerializedLexicalNode,
  type Spread,
  type TextNode,
} from "lexical";
import { createContext, type ReactNode, useContext } from "react";

import { cx } from "../cx";
import { MentionedWorker } from "../../workers/live";
import { InlineAttachment } from "./attachments";
import type { Chip } from "./draft";
import { COMMAND_TONES, CommandKindIcon, fileTone, MentionKindIcon, NOTE_TONE, noteName } from "./kind-icons";
import type { SlashCommand } from "./menus";
import { ToolIcon } from "./tools";

/** What a chip opens: a mention's file, folder or chat, a command's source, an image or a pasted text. */
export type OpenKind = "file" | "folder" | "chat" | "worker" | "tab" | "note" | "plugin" | "command" | "tool" | "skill" | "mcp" | "image" | "paste";

/** What the chips in a field reach: the field's `onOpen`, and the `/` menu's commands by id for their icons. */
export const ChipContext = createContext<{ onOpen?: (kind: OpenKind, id: string, name?: string) => void; commands: ReadonlyMap<string, SlashCommand> }>({
  commands: new Map(),
});

/**
 * A chip as the text shows it, with its menu row's icon: a command's name in its kind's colour, a file's in its
 * glyph's where that has one, otherwise blue;
 * an image's thumbnail or a pasted text, with ✕ in the field. A click opens what it names. A sent message draws
 * the same chip [D2107].
 */
export function ComposerChip({ chip, onRemove }: { chip: Chip; onRemove?: () => void }) {
  const { onOpen, commands } = useContext(ChipContext);
  if (chip.kind === "image" || chip.kind === "paste") {
    return (
      <InlineAttachment
        id={chip.attachmentId}
        paste={chip.kind === "paste"}
        preview={chip.kind === "paste" ? chip.preview : undefined}
        onOpen={onOpen && (() => onOpen(chip.kind, chip.attachmentId, chip.kind === "paste" ? chip.preview : undefined))}
        onRemove={onRemove}
      />
    );
  }
  // A worker is the pill a worker has everywhere in the conversation [D3010].
  if (chip.kind === "mention" && chip.type === "worker") return <MentionedWorker id={chip.id} onOpen={onOpen} />;
  const open = onOpen && (() => onOpen(chip.type, chip.id));
  const command = chip.kind === "command";
  const content = command ? (
    <>
      {chip.type === "tool" ? <ToolIcon id={chip.id} className="mr-0.5 inline-block size-icon-sm align-icon" /> : <CommandKindIcon kind={chip.type} icon={commands.get(chip.id)?.icon} className="mr-0.5 inline-block size-icon-sm align-icon" />}
      {chip.label}
    </>
  ) : (
    <>
      <MentionKindIcon type={chip.type} id={chip.id} label={chip.label} className="mr-0.5 inline-block size-icon-sm align-icon" />
      {chip.type === "note" ? noteName(chip.label).name : chip.type === "chat" || chip.type === "tab" || chip.type === "plugin" ? chip.label : chip.label.slice(chip.label.lastIndexOf("/") + 1)}
    </>
  );
  const tone = command ? COMMAND_TONES[chip.type] : chip.type === "note" ? NOTE_TONE : (chip.type === "file" && fileTone(chip.label)) || "text-link";
  // A button where it opens, so Tab reaches it and Enter or Space opens it (the field leaves those to buttons).
  return open ? (
    <button type="button" data-slot="composer-chip" onClick={open} className={cx("inline cursor-pointer rounded-xs focus-visible:focus-ring", tone)}>
      {content}
    </button>
  ) : (
    <span data-slot="composer-chip" className={tone}>
      {content}
    </span>
  );
}

/** A chip in the field: ✕ takes it out of the text as Backspace would, its attachment kept for undo. */
function FieldChip({ chip, nodeKey }: { chip: Chip; nodeKey: NodeKey }) {
  const [editor] = useLexicalComposerContext();
  const remove = () => {
    editor.update(() => $getNodeByKey(nodeKey)?.remove());
    editor.focus();
  };
  return <ComposerChip chip={chip} onRemove={editor.isEditable() ? remove : undefined} />;
}

type SerializedChipNode = Spread<{ chip: Chip }, SerializedLexicalNode>;

/** A chip inside the field's text: one unit the caret steps over and Backspace takes whole. */
export class ChipNode extends DecoratorNode<ReactNode> {
  __chip: Chip;

  static getType(): string {
    return "chip";
  }
  static clone(node: ChipNode): ChipNode {
    return new ChipNode(node.__chip, node.__key);
  }
  static importJSON(json: SerializedChipNode): ChipNode {
    return new ChipNode(json.chip);
  }
  constructor(chip: Chip, key?: NodeKey) {
    super(key);
    this.__chip = chip;
  }
  exportJSON(): SerializedChipNode {
    return { ...super.exportJSON(), chip: this.__chip };
  }
  createDOM(): HTMLElement {
    return document.createElement("span");
  }
  updateDOM(): false {
    return false;
  }
  isInline(): true {
    return true;
  }
  // The caret steps over it and Backspace takes it at once, rather than selecting it first.
  isKeyboardSelectable(): false {
    return false;
  }
  getTextContent(): string {
    const chip = this.__chip;
    return chip.kind === "mention" ? `@${chip.label}` : chip.kind === "command" ? chip.label : "";
  }
  decorate(): ReactNode {
    return <FieldChip chip={this.__chip} nodeKey={this.__key} />;
  }
}

export const $isChipNode = (node: LexicalNode | null | undefined): node is ChipNode => node instanceof ChipNode;

/** `node` in the text, then a space after it unless one follows, the caret after that. */
export function $putWithSpace(node: LexicalNode, replacing: TextNode | null): void {
  if (replacing) replacing.replace(node);
  const next = node.getNextSibling();
  if ($isTextNode(next) && /^\s/.test(next.getTextContent())) {
    next.select(1, 1);
    return;
  }
  const space = $createTextNode(" ");
  node.insertAfter(space);
  space.select(1, 1);
}

/** `chip` where `caret` was (the end when it's gone or never was), spaced off what's around it, the caret after it. */
export function $insertChip(chip: Chip, caret: RangeSelection | null): void {
  if (caret && $getNodeByKey(caret.anchor.key) && $getNodeByKey(caret.focus.key)) $setSelection(caret.clone());
  else $getRoot().selectEnd();
  const node = new ChipNode(chip);
  $getSelection()!.insertNodes([node]);
  const before = node.getPreviousSibling();
  if (before && !($isTextNode(before) && /\s$/.test(before.getTextContent()))) node.insertBefore($createTextNode(" "));
  $putWithSpace(node, null);
}
