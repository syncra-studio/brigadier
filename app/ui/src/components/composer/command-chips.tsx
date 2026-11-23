import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isListNode } from "@lexical/list";
import { $getRoot, $isElementNode, $isLineBreakNode, $isTextNode, type ElementNode, TextNode } from "lexical";
import { useEffect } from "react";

import { ChipNode } from "./chip";
import type { SlashCommand } from "./menus";

/** `inCode`: the backtick run that opened the code span the text is in (0: none). */
type Scan = { fenced: boolean; skip: boolean; inCode: number; afterSpace: boolean; lineStart: boolean };

/** The run of backticks starting at `at`: one opens a code span, a run as long closes it (``a ` b``). */
function tick(text: string, at: number, inCode: number): { inCode: number; length: number } {
  const length = /^`+/.exec(text.slice(at))![0].length;
  return { inCode: inCode === 0 ? length : inCode === length ? 0 : inCode, length };
}

/** The field's lines in order: its paragraphs and its list items, nested ones too. */
function $lines(parent: ElementNode): ElementNode[] {
  return parent.getChildren().flatMap((node) => (!$isElementNode(node) ? [] : $isListNode(node) || $isListNode(node.getFirstChild()) ? $lines(node) : [node]));
}

/**
 * Where `target` starts in the text: inside a ``` block or on its fence line, inside a `code` span, right after
 * a space or a line's start. Null if it isn't in the text.
 */
function $scanTo(target: TextNode): Scan | null {
  const at: Scan = { fenced: false, skip: false, inCode: 0, afterSpace: true, lineStart: true };
  const newLine = () => Object.assign(at, { lineStart: true, skip: false, inCode: 0, afterSpace: true });
  for (const paragraph of $lines($getRoot())) {
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
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "`") {
          const run = tick(text, i, at.inCode);
          at.inCode = run.inCode;
          i += run.length - 1;
        }
        at.afterSpace = /\s/.test(text[i]!);
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
        if (letter === "`") {
          const run = tick(text, at, inCode);
          inCode = run.inCode;
          at += run.length - 1;
        } else if (letter === "/" && afterSpace && !inCode) {
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
