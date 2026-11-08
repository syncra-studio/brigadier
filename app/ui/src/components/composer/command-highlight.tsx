import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $isElementNode, $isLineBreakNode, $isTextNode, type LexicalEditor } from "lexical";
import { useEffect } from "react";

import type { SlashCommand } from "./menus";

// Every field's painted commands, in the one highlight the page has for them.
const painted = new Map<LexicalEditor, Range[]>();
const repaint = () => CSS.highlights.set("composer-command", new Highlight(...[...painted.values()].flat()));

/** The commands in the text: a `/word` starting a word and naming one in `names`, never in `code` or a ``` block. */
function $commandRanges(editor: LexicalEditor, names: ReadonlySet<string>): Range[] {
  const ranges: Range[] = [];
  let fenced = false;
  for (const paragraph of $getRoot().getChildren()) {
    if (!$isElementNode(paragraph)) continue;
    // Per line: whether it's a fence, whether a `code` span is open, whether the last character was a space.
    let lineStart = true;
    let skip = false;
    let inCode = false;
    let afterSpace = true;
    for (const node of paragraph.getChildren()) {
      if ($isLineBreakNode(node)) {
        lineStart = true;
        skip = false;
        inCode = false;
        afterSpace = true;
        continue;
      }
      if (!$isTextNode(node)) {
        // A chip.
        lineStart = false;
        afterSpace = false;
        continue;
      }
      const text = node.getTextContent();
      if (lineStart && text.trimStart().startsWith("```")) {
        fenced = !fenced;
        skip = true;
      }
      lineStart = false;
      if (fenced || skip) continue;
      const dom = editor.getElementByKey(node.getKey())?.firstChild;
      for (let at = 0; at < text.length; at++) {
        const letter = text[at]!;
        if (letter === "`") inCode = !inCode;
        else if (letter === "/" && afterSpace && !inCode && dom) {
          const word = (/^\/[^\s`]+/.exec(text.slice(at))?.[0] ?? "").replace(/[.,;:!?)]+$/, "");
          if (names.has(word)) {
            const range = new Range();
            range.setStart(dom, at);
            range.setEnd(dom, at + word.length);
            ranges.push(range);
          }
        }
        afterSpace = /\s/.test(letter);
      }
    }
  }
  return ranges;
}

/**
 * Paints each of the menu's commands in the text in the chips' blue, picked or typed by hand ("use the /docs
 * skill"), as Rust will read them; a path like /usr/bin, or one in `code`, stays plain. Paint only: the text
 * stays as typed.
 */
export function CommandHighlight({ commands }: { commands: SlashCommand[] | null }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const names = new Set((commands ?? []).map((command) => command.label));
    const paint = () => {
      painted.set(editor, editor.getEditorState().read(() => $commandRanges(editor, names)));
      repaint();
    };
    paint();
    const off = editor.registerUpdateListener(paint);
    return () => {
      off();
      painted.delete(editor);
      repaint();
    };
  }, [editor, commands]);
  return null;
}
