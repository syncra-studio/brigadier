import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $isElementNode, $isLineBreakNode, $isTextNode, TextNode } from "lexical";
import { useEffect } from "react";

import { ChipNode } from "./chip";
import type { SlashCommand } from "./menus";

type Scan = { fenced: boolean; skip: boolean; inCode: boolean; afterSpace: boolean; lineStart: boolean };

/**
 * Where `target` starts in the text: inside a ``` block or on its fence line, inside a `code` span, right after
 * a space or a line's start. Null if it isn't in the text.
 */
function $scanTo(target: TextNode): Scan | null {
  const at: Scan = { fenced: false, skip: false, inCode: false, afterSpace: true, lineStart: true };
  const newLine = () => Object.assign(at, { lineStart: true, skip: false, inCode: false, afterSpace: true });
  for (const paragraph of $getRoot().getChildren()) {
    if (!$isElementNode(paragraph)) continue;
    newLine();
    for (const node of paragraph.getChildren()) {
      if ($isLineBreakNode(node)) {
        newLine();
        continue;
      }
      const text = $isTextNode(node) ? node.getTextContent() : null;
      if (text !== null && at.lineStart && text.trimStart().startsWith("```")) {
        at.fenced = !at.fenced;
        at.skip = true;
      }
      if (node.is(target)) return at;
      at.lineStart = false;
      if (text === null) {
        // A chip.
        at.afterSpace = false;
        continue;
      }
      for (const letter of text) {
        if (letter === "`") at.inCode = !at.inCode;
        at.afterSpace = /\s/.test(letter);
      }
    }
  }
  return null;
}

/**
 * Turns each of the menu's commands in the text into its chip, picked or typed by hand ("use the /docs skill"),
 * once a space ends it: a `/word` starting a word and naming a listed command that isn't `instant`. One in `code` or a ``` block, or
 * a path like /usr/bin, stays text.
 */
export function CommandChips({ commands }: { commands: SlashCommand[] | null }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    // One that runs at once when picked stays plain when typed.
    const byLabel = new Map((commands ?? []).filter((command) => !command.instant).map((command) => [command.label, command]));
    if (byLabel.size === 0) return;
    return editor.registerNodeTransform(TextNode, (node) => {
      if (!node.isSimpleText()) return;
      const scan = $scanTo(node);
      if (!scan || scan.fenced || scan.skip) return;
      let { inCode, afterSpace } = scan;
      const text = node.getTextContent();
      for (let at = 0; at < text.length; at++) {
        const letter = text[at]!;
        if (letter === "`") inCode = !inCode;
        else if (letter === "/" && afterSpace && !inCode) {
          // Ended by a space; a full stop or comma after it stays text.
          const word = (/^\/[^\s`]+(?=\s)/.exec(text.slice(at))?.[0] ?? "").replace(/[.,;:!?)]+$/, "");
          const command = byLabel.get(word);
          if (command) {
            const parts = node.splitText(at, at + word.length);
            parts[at === 0 ? 0 : 1]!.replace(new ChipNode({ kind: "command", id: command.id, type: command.kind, label: command.label }));
            // The text after it changed too, so this runs again on it.
            return;
          }
        }
        afterSpace = /\s/.test(letter);
      }
    });
  }, [editor, commands]);
  return null;
}
