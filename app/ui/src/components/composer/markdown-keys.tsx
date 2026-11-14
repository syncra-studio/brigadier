import { $insertDataTransferForPlainText } from "@lexical/clipboard";
import { ListItemNode } from "@lexical/list";
import { ORDERED_LIST, UNORDERED_LIST } from "@lexical/markdown";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { useLexicalTextEntity } from "@lexical/react/useLexicalTextEntity";
import { $getNearestNodeOfType, mergeRegister } from "@lexical/utils";
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_LOW,
  COMMAND_PRIORITY_NORMAL,
  type EditorConfig,
  FORMAT_TEXT_COMMAND,
  INDENT_CONTENT_COMMAND,
  INSERT_LINE_BREAK_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  KEY_TAB_COMMAND,
  OUTDENT_CONTENT_COMMAND,
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
const LISTS = [UNORDERED_LIST, ORDERED_LIST];

/** A Markdown list item's start: its indent, its marker (`-`, `*`, `+` or `1.`) and the space after it. */
export const ITEM = /^( *)([-*+]|(\d{1,9})\.) /;

/** The list item the caret is in, if any. */
export const $caretItem = () => {
  const selection = $getSelection();
  return $isRangeSelection(selection) ? $getNearestNodeOfType(selection.anchor.getNode(), ListItemNode) : null;
};

/**
 * Drawn lists and links [D295]: `- `, `* ` or `1. ` and Space at a line's start starts a
 * bulleted or numbered list (the note's own list nodes); a new line in one adds an item, in an empty one ends the
 * list; Backspace at an item's start makes it text again; Tab and ⇧Tab nest it and bring it back. The field reads as
 * Markdown (field.tsx). A URL pasted over selected text makes `[text](url)`; a web address shows in link blue.
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
            const item = $caretItem();
            if (!item || event.altKey || event.metaKey || event.ctrlKey) return false;
            event.preventDefault();
            // The first item has nothing to nest under.
            if (event.shiftKey || item.getPreviousSibling()) editor.dispatchCommand(event.shiftKey ? OUTDENT_CONTENT_COMMAND : INDENT_CONTENT_COMMAND, undefined);
            return true;
          },
          COMMAND_PRIORITY_NORMAL,
        ),
        // Every line is its own block, so `- ` starts a list on any of them, and in a list ⇧⏎ adds an item as ⏎ does.
        editor.registerCommand(INSERT_LINE_BREAK_COMMAND, () => editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined), COMMAND_PRIORITY_NORMAL),
        // Text only: no bold or italic in a message, and a paste from elsewhere comes in as its text.
        editor.registerCommand(FORMAT_TEXT_COMMAND, () => true, COMMAND_PRIORITY_NORMAL),
        editor.registerCommand(
          PASTE_COMMAND,
          (event) => {
            const selection = $getSelection();
            const data = event instanceof ClipboardEvent ? event.clipboardData : null;
            if (!data || !$isRangeSelection(selection)) return false;
            event.preventDefault();
            $insertDataTransferForPlainText(data, selection);
            return true;
          },
          COMMAND_PRIORITY_LOW,
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
  return (
    <>
      <ListPlugin />
      <MarkdownShortcutPlugin transformers={LISTS} />
    </>
  );
}
