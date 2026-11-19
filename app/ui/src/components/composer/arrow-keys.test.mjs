import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, BEFORE_INPUT_COMMAND, COMMAND_PRIORITY_LOW, createEditor, KEY_DOWN_COMMAND, REDO_COMMAND, UNDO_COMMAND } from "lexical";
import { registerArrowKeys } from "./arrow-keys.ts";

const { createEmptyHistoryState, registerHistory } = createRequire(import.meta.resolve("@lexical/react/LexicalHistoryPlugin"))("@lexical/history");
const event = (data) => ({ altKey: false, ctrlKey: false, metaKey: false, isComposing: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...data });

function field(t, value) {
  const editor = createEditor({ onError: (error) => { throw error; } });
  const update = (fn) => editor.update(fn, { discrete: true });
  t.after(registerHistory(editor, createEmptyHistoryState(), 1000));
  t.after(registerArrowKeys(editor));
  // Stand in for the browser's native typing/deletion, below the composer's handlers.
  t.after(editor.registerCommand(KEY_DOWN_COMMAND, () => true, COMMAND_PRIORITY_LOW));
  t.after(editor.registerCommand(BEFORE_INPUT_COMMAND, (input) => {
    $getSelection().insertText(input.data);
    return true;
  }, COMMAND_PRIORITY_LOW));
  update(() => {
    for (const line of value.split("\n")) {
      const caret = line.indexOf("|");
      const node = $createTextNode(line.replace("|", ""));
      $getRoot().append($createParagraphNode().append(node));
      if (caret >= 0) node.select(caret, caret);
    }
  });
  const command = (type, data) => {
    update(() => editor.dispatchCommand(type, data));
  };
  return {
    update, command,
    text: () => editor.read(() => $getRoot().getTextContent().replaceAll("\n\n", "\n")),
    caret: () => editor.read(() => $getSelection().anchor.offset),
    type: (text, inputType = "insertText", extra = {}) => {
      command(KEY_DOWN_COMMAND, event({ key: text, ...extra }));
      const input = event({ inputType, data: text, ...extra });
      command(BEFORE_INPUT_COMMAND, input);
      return input;
    },
    backspace: () => {
      const key = event({ key: "Backspace" });
      command(KEY_DOWN_COMMAND, key);
      if (!key.defaultPrevented) update(() => {
        const selection = $getSelection();
        selection.anchor.offset--;
        selection.insertText("");
      });
      return key;
    },
  };
}

test("typed -> replaces only those characters at the caret; Backspace restores them [D889 D890]", (t) => {
  const f = field(t, "a | suffix");
  f.type("-");
  assert.ok(f.type(">").defaultPrevented);
  assert.equal(f.text(), "a → suffix");
  assert.equal(f.caret(), 3);
  assert.ok(f.backspace().defaultPrevented);
  assert.equal(f.text(), "a -> suffix");
  assert.equal(f.caret(), 4);
  assert.ok(!f.backspace().defaultPrevented, "a second Backspace deletes normally");
  assert.equal(f.text(), "a - suffix");
});

test("code spans and fenced blocks keep ->; closed code and escaped ticks allow the arrow", (t) => {
  for (const [before, code] of [
    ["`value -", true], ["``value ` -", true], ["`done` -", false], ["\\`literal -", false],
    ["```ts\nvalue -", true], ["~~~\nvalue -", true], ["````\n```\nvalue -", true],
    ["```\nvalue\n```\nnext -", false], ["~~~\nvalue\n~~~\nnext -", false],
    ["`line\nstill -", true], ["`line\n\nnext -", false],
  ]) {
    const f = field(t, before + "|");
    f.type(">");
    assert.equal(f.text(), before.slice(0, -1) + (code ? "->" : "→"), before);
  }
});

test("pastes, composition and other sequences stay as typed", (t) => {
  for (const [before, text, inputType, extra] of [
    ["", "->", "insertFromPaste"], ["-", ">", "insertFromPaste"],
    ["-", ">", "insertText", { isComposing: true }], ["", "<-", "insertText"], ["=", ">", "insertText"],
  ]) {
    const f = field(t, before + "|");
    assert.ok(!f.type(text, inputType, extra).defaultPrevented);
    assert.equal(f.text(), before + text);
  }
});

test("typing or moving the caret ends the immediate Backspace reversal", (t) => {
  const f = field(t, "-|");
  f.type(">");
  f.type("x");
  f.backspace();
  assert.equal(f.text(), "→");
  f.backspace();
  assert.equal(f.text(), "");
  f.type("-");
  f.type(">");
  f.update(() => $getRoot().getFirstChild().getFirstChild().select(0, 0));
  f.update(() => $getRoot().selectEnd());
  assert.ok(!f.backspace().defaultPrevented);
  assert.equal(f.text(), "");
});

test("Lexical undo/redo preserves replacement and Backspace boundaries", (t) => {
  const f = field(t, "-|");
  f.type(">");
  f.backspace();
  f.command(UNDO_COMMAND);
  assert.equal(f.text(), "→");
  f.command(UNDO_COMMAND);
  assert.equal(f.text(), "-");
  f.command(REDO_COMMAND);
  assert.equal(f.text(), "→");
  f.command(REDO_COMMAND);
  assert.equal(f.text(), "->");
});
