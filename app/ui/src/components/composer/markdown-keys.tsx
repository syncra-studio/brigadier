import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useLexicalTextEntity } from "@lexical/react/useLexicalTextEntity";
import { mergeRegister } from "@lexical/utils";
import {
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_NORMAL,
  type EditorConfig,
  INSERT_LINE_BREAK_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalNode,
  PASTE_COMMAND,
  type SerializedTextNode,
  TextNode,
} from "lexical";
import { useEffect } from "react";

/** A web address in the composer's text, drawn in link blue; it stays its own text in what's sent. */
export class UrlNode extends TextNode {
  static getType() {
    return "url";
  }
  static clone(node: UrlNode) {
    return new UrlNode(node.__text, node.__key);
  }
  static importJSON(json: SerializedTextNode) {
    return new UrlNode(json.text).updateFromJSON(json);
  }
  createDOM(config: EditorConfig) {
    const dom = super.createDOM(config);
    dom.classList.add("text-link");
    return dom;
  }
  canInsertTextBefore() {
    return false;
  }
  isTextEntity() {
    return true;
  }
}

// Sentence punctuation after an address isn't part of it (the old app's URL_TAIL).
const URL = /(?<=^|\s)https?:\/\/[^\s<>"'`]+?(?=[.,;:!?)\]}*_~]*(?:\s|$))/;
// Stable: a new function re-registers the transform, which redraws every node, which renders again.
function urlIn(text: string) {
  const match = URL.exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}
const toUrl = (node: TextNode) => new UrlNode(node.getTextContent());
const ONLY_URL = /^https?:\/\/\S+$/;

/** A list item's start: its indent, its marker (`-`, `*`, `+` or `1.`) and the space after it. */
const ITEM = /^( *)([-*+]|(\d{1,9})\.) /;

/** The first node of `node`'s line: where the paragraph starts or the line break before it ends. */
function $lineHead(node: LexicalNode): LexicalNode {
  for (let previous = node.getPreviousSibling(); previous && !$isLineBreakNode(previous); previous = node.getPreviousSibling()) node = previous;
  return node;
}

/** The caret's line's first node, if text, and the caret's offset in it (null when it's further on); null at an empty line's start or over a selection. */
function $caretLine(): { head: TextNode; offset: number | null } | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const anchor = selection.anchor;
  let node: LexicalNode | null = anchor.getNode();
  if ($isElementNode(node)) node = node.getChildAtIndex(anchor.offset - 1);
  if (!node || $isLineBreakNode(node)) return null;
  const head = $lineHead(node);
  if (!$isTextNode(head)) return null;
  return { head, offset: head.is(anchor.getNode()) ? anchor.offset : null };
}

/** The line before `head`'s, its first text node: null at the first line. */
function $previousHead(head: LexicalNode): TextNode | null {
  const before = head.getPreviousSibling()?.getPreviousSibling();
  if (!before) return null;
  const previous = $lineHead(before);
  return $isTextNode(previous) ? previous : null;
}

/** Adds `delta` spaces at `head`'s start (takes them off if negative), the caret kept where it was in the text. */
function $shift(head: TextNode, delta: number, marker?: string) {
  const selection = $getSelection();
  const at = $isRangeSelection(selection) && selection.anchor.key === head.getKey() ? selection.anchor.offset : null;
  const item = ITEM.exec(head.getTextContent())!;
  const before = item[0].length;
  const next = " ".repeat(Math.max(0, item[1]!.length + delta)) + (marker ?? item[2]) + " ";
  head.spliceText(0, before, next);
  if (at !== null && $isRangeSelection(selection)) {
    const offset = Math.max(next.length, at + next.length - before);
    selection.anchor.set(head.getKey(), offset, "text");
    selection.focus.set(head.getKey(), offset, "text");
  }
}

/**
 * Markdown lists and links as typed, the text itself staying the Markdown that's sent [D253, D259]: `- ` or `1. ` starts an
 * item; a new line (⇧⏎) in one starts the next, in an empty one ends the list; Tab and
 * ⇧Tab indent and outdent an item under the one above. A URL pasted over selected text makes `[text](url)`; a
 * web address shows in link blue.
 */
export function MarkdownKeys() {
  const [editor] = useLexicalComposerContext();
  useLexicalTextEntity(urlIn, UrlNode, toUrl);
  useEffect(
    () =>
      mergeRegister(
        editor.registerCommand(
          KEY_TAB_COMMAND,
          (event) => {
            const line = $caretLine();
            if (!line || event.altKey || event.metaKey || event.ctrlKey) return false;
            const item = ITEM.exec(line.head.getTextContent());
            if (!item) return false;
            event.preventDefault();
            // Under the item above: as deep as its text starts (2 under `- `, 3 under `1. `), numbered from 1 again.
            const indent = item[1]!.length;
            let above = $previousHead(line.head);
            if (!event.shiftKey) {
              const parent = above && ITEM.exec(above.getTextContent());
              if (parent && parent[1]!.length >= indent) $shift(line.head, parent[0].length - indent, item[3] ? "1." : undefined);
              return true;
            }
            for (; above; above = $previousHead(above)) {
              const parent = ITEM.exec(above.getTextContent());
              if (!parent) break;
              if (parent[1]!.length < indent) {
                // After the item it was under, numbered on from it.
                $shift(line.head, parent[1]!.length - indent, item[3] && parent[3] ? `${Number(parent[3]) + 1}.` : undefined);
                return true;
              }
            }
            if (indent > 0) $shift(line.head, -indent);
            return true;
          },
          COMMAND_PRIORITY_NORMAL,
        ),
        editor.registerCommand(
          INSERT_LINE_BREAK_COMMAND,
          () => {
            const line = $caretLine();
            const text = line?.head.getTextContent() ?? "";
            const item = ITEM.exec(text);
            // The caret past the marker: later in the line (after a chip) or in its first text after it.
            if (!line || !item || (line.offset !== null && line.offset < item[0].length)) return false;
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return false;
            const next = line.head.getNextSibling();
            if (text === item[0] && (!next || $isLineBreakNode(next))) {
              // An empty item ends the list: its marker goes, the caret stays on the line.
              line.head.select(0, text.length).removeText();
              return true;
            }
            selection.insertLineBreak();
            selection.insertText(`${item[1]}${item[3] ? `${Number(item[3]) + 1}.` : item[2]} `);
            return true;
          },
          COMMAND_PRIORITY_NORMAL,
        ),
        editor.registerCommand(
          PASTE_COMMAND,
          (event) => {
            const url = event instanceof ClipboardEvent ? event.clipboardData?.getData("text/plain").trim() : null;
            const selection = $getSelection();
            if (!url || !ONLY_URL.test(url) || !$isRangeSelection(selection) || selection.isCollapsed()) return false;
            const text = selection.getTextContent();
            if (!text.trim() || /[\n\]]/.test(text) || !selection.getNodes().every($isTextNode)) return false;
            event.preventDefault();
            selection.insertText(`[${text}](${url})`);
            return true;
          },
          COMMAND_PRIORITY_NORMAL,
        ),
      ),
    [editor],
  );
  return null;
}
