import { DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from "lexical";
import type { ReactNode } from "react";

import { Chat, File } from "../../icons";
import type { Chip } from "./draft";

const ICON = "mr-0.5 inline-block size-icon-sm align-text-bottom";

/** A chip as the text shows it: a mention's icon and blue name. */
export function ComposerChip({ chip }: { chip: Chip }) {
  // shortcut: image and pasted-text chips show a plain word until slice 3 draws their thumbnail and ✕.
  if (chip.kind !== "mention") return <span className="text-muted-foreground">{chip.kind === "image" ? "Image" : "Pasted text"}</span>;
  const name = chip.type === "chat" ? chip.label : chip.label.slice(chip.label.lastIndexOf("/") + 1);
  return (
    <span className="text-link">
      {/* shortcut: folders take the file icon until slice 3 adds the old app's Folder. */}
      {chip.type === "chat" ? <Chat className={ICON} /> : <File className={ICON} />}
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
    return <ComposerChip chip={this.__chip} />;
  }
}

export const $isChipNode = (node: LexicalNode | null | undefined): node is ChipNode => node instanceof ChipNode;
