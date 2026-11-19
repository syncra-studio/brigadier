import { mergeRegister } from "@lexical/utils";
import {
  $addUpdateTag,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  BEFORE_INPUT_COMMAND,
  COMMAND_PRIORITY_NORMAL,
  HISTORY_PUSH_TAG,
  KEY_DOWN_COMMAND,
  type LexicalEditor,
  type RangeSelection,
} from "lexical";

function inCode(before: string): boolean {
  let fence = "";
  let ticks = 0;
  for (const line of before.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = "";
      continue;
    }
    if (marker && (marker[1]![0] === "~" || !marker[2]!.includes("`"))) {
      fence = marker[1]!;
      ticks = 0;
      continue;
    }
    if (!line.trim()) ticks = 0;
    for (let at = 0; at < line.length; at++) {
      if (!ticks && line[at] === "\\") { at++; continue; }
      if (line[at] !== "`") continue;
      let length = 1;
      while (line[at + 1] === "`") { length++; at++; }
      if (!ticks) ticks = length;
      else if (ticks === length) ticks = 0;
    }
  }
  return !!fence || ticks > 0;
}

function $beforeCaret(selection: RangeSelection): string {
  const before = selection.clone();
  before.anchor.set("root", 0, "element");
  return before.getTextContent();
}

/** Only typed ->, with one Backspace to decline the replacement [D889 D890]. */
export function registerArrowKeys(editor: LexicalEditor): () => void {
  let undo: { text: string; before: string } | null = null;
  const $atArrow = () => {
    const selection = $getSelection();
    return undo && $isRangeSelection(selection) && selection.isCollapsed() &&
      $getRoot().getTextContent() === undo.text && $beforeCaret(selection) === undo.before;
  };
  return mergeRegister(
    editor.registerCommand(KEY_DOWN_COMMAND, (event) => {
      const restore = event.key === "Backspace" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing && $atArrow();
      undo = null;
      if (!restore) return false;
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || selection.anchor.type !== "text" || selection.anchor.offset === 0) return false;
      selection.anchor.offset--;
      selection.insertText("->");
      $addUpdateTag(HISTORY_PUSH_TAG);
      event.preventDefault();
      return true;
    }, COMMAND_PRIORITY_NORMAL),
    editor.registerCommand(BEFORE_INPUT_COMMAND, (event) => {
      undo = null;
      if (event.inputType !== "insertText" || event.data !== ">" || event.isComposing || editor.isComposing()) return false;
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed() || selection.anchor.type !== "text") return false;
      const node = selection.anchor.getNode();
      const offset = selection.anchor.offset;
      if (!$isTextNode(node) || node.getTextContent()[offset - 1] !== "-" || inCode($beforeCaret(selection))) return false;
      selection.anchor.offset--;
      selection.insertText("→");
      $addUpdateTag(HISTORY_PUSH_TAG);
      undo = { text: $getRoot().getTextContent(), before: $beforeCaret(selection) };
      event.preventDefault();
      return true;
    }, COMMAND_PRIORITY_NORMAL),
    editor.registerUpdateListener(({ editorState }) => {
      if (undo && !editorState.read($atArrow)) undo = null;
    }),
  );
}
