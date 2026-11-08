import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNodeByKey, DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from "lexical";
import type { ReactNode } from "react";

import { InlineAttachment, MentionIcon } from "./attachments";
import type { Chip } from "./draft";

/** A chip as the text shows it: a mention's icon and blue name; an image's thumbnail or a pasted text, with ✕. */
export function ComposerChip({ chip, nodeKey }: { chip: Chip; nodeKey: NodeKey }) {
  const [editor] = useLexicalComposerContext();
  if (chip.kind !== "mention") {
    // As Backspace would: out of the text, its attachment kept for undo.
    const remove = () => {
      editor.update(() => $getNodeByKey(nodeKey)?.remove());
      editor.focus();
    };
    return (
      <InlineAttachment
        id={chip.attachmentId}
        paste={chip.kind === "paste"}
        preview={chip.kind === "paste" ? chip.preview : undefined}
        onRemove={editor.isEditable() ? remove : undefined}
      />
    );
  }
  const name = chip.type === "chat" ? chip.label : chip.label.slice(chip.label.lastIndexOf("/") + 1);
  return (
    <span data-slot="composer-chip" className="cursor-pointer text-link">
      <MentionIcon type={chip.type} label={chip.label} className="mr-0.5 inline-block size-icon-sm align-icon" />
      {name}
    </span>
  );
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
    return this.__chip.kind === "mention" ? `@${this.__chip.label}` : "";
  }
  decorate(): ReactNode {
    return <ComposerChip chip={this.__chip} nodeKey={this.__key} />;
  }
}

export const $isChipNode = (node: LexicalNode | null | undefined): node is ChipNode => node instanceof ChipNode;
