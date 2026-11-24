import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { EditorRefPlugin } from "@lexical/react/LexicalEditorRefPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { HorizontalRulePlugin } from "@lexical/react/LexicalHorizontalRulePlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { TabIndentationPlugin } from "@lexical/react/LexicalTabIndentationPlugin";
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
import { $getRoot, type EditorThemeClasses, type LexicalEditor } from "lexical";
import { type RefObject, useState } from "react";

import { openLink } from "../browser/links";
import { ImagePlugin } from "./image";
import { $exportPage, $importPage, PAGE_NODES, PAGE_TRANSFORMERS } from "./markdown";
import { DragHandles, SelectionToolbar, type SendTo, SlashMenu } from "./tools";

const THEME: EditorThemeClasses = {
  paragraph: "note-p",
  heading: { h1: "note-h1", h2: "note-h2", h3: "note-h3", h4: "note-h4", h5: "note-h4", h6: "note-h4" },
  quote: "note-quote",
  list: {
    ul: "note-ul",
    ol: "note-ol",
    checklist: "note-checklist",
    listitem: "note-li",
    listitemChecked: "note-li-checked",
    listitemUnchecked: "note-li-unchecked",
    nested: { listitem: "note-li-nested" },
  },
  link: "note-link",
  code: "note-code",
  hr: "note-hr",
  table: "note-table",
  tableCell: "note-td",
  tableCellHeader: "note-th",
  text: {
    bold: "note-bold",
    italic: "note-italic",
    underline: "note-underline",
    strikethrough: "note-strike",
    underlineStrikethrough: "note-underline-strike",
    code: "note-inline-code",
  },
};

/** Links in a note only ever open web and mail addresses. */
export function safeLink(url: string): boolean {
  return /^(?:https?:|mailto:)/i.test(url);
}

/**
 * A note's body, the old app's page editor: Markdown in, Markdown out on every change. Remount it (a new `key`) to
 * load content that changed outside it [D281].
 */
export function NoteEditor({ body, label, editorRef, onChange, onSend }: { body: string; label: string; editorRef: RefObject<LexicalEditor | null>; onChange: (markdown: string) => void; onSend?: (text: string, to: SendTo) => void }) {
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  return (
    <LexicalComposer
      initialConfig={{
        namespace: "note",
        nodes: PAGE_NODES,
        theme: THEME,
        onError: (error) => console.error("The note editor failed", error),
        editorState: () => $importPage(body),
      }}
    >
      <div
        ref={setAnchor}
        data-slot="note-body"
        className="note-body"
        // ⌘-click (Ctrl-click) opens a link in the browser; the links are reached by keyboard through the editor.
        onClick={(event) => {
          const href = event.target instanceof Element ? event.target.closest("a[href]")?.getAttribute("href") : null;
          if (!href || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          if (safeLink(href)) openLink(href);
        }}
      >
        <RichTextPlugin contentEditable={<ContentEditable aria-label={label} className="note-content" spellCheck />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
      </div>
      <HistoryPlugin />
      <ListPlugin />
      <CheckListPlugin />
      <LinkPlugin validateUrl={safeLink} />
      <TablePlugin hasCellMerge={false} hasCellBackgroundColor={false} />
      <HorizontalRulePlugin />
      <TabIndentationPlugin />
      <MarkdownShortcutPlugin transformers={PAGE_TRANSFORMERS} />
      <OnChangePlugin ignoreSelectionChange onChange={(state) => onChange(state.read(() => $exportPage()))} />
      <EditorRefPlugin editorRef={editorRef} />
      <ImagePlugin />
      <SlashMenu />
      <SelectionToolbar onSend={onSend} />
      <DragHandles anchor={anchor} />
    </LexicalComposer>
  );
}

/** Puts the caret at the start of the note's first block. */
export function focusNoteStart(editor: LexicalEditor): void {
  editor.focus(() => editor.update(() => $getRoot().selectStart()));
}
