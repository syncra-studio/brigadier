import type { LexicalEditor } from "lexical";
import { useEffect, useRef, useState } from "react";

import { Button } from "../components/button";
import { ConfirmDialog } from "../components/confirm-dialog";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/menu";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { ChevronDown, Copy } from "../icons";
import { SimpleSmile, SquarePlus } from "../icons/note";
import { Download } from "../icons/sidebar";
import { StickyNote } from "../icons/tab";
import { EditPencil, Trash } from "../icons/thread";
import { applyBlock, BLOCKS } from "./blocks";
import { BlockRow } from "./tools";

type Content = { emoji: string | null; title: string; body: string };

const EMOJI = [
  "📝", "📄", "📌", "📎", "📚", "📖", "🗒️", "🗂️",
  "💡", "✅", "☑️", "⭐", "🔥", "🚀", "🎯", "🏁",
  "🐛", "🔧", "🛠️", "⚙️", "🧪", "🧭", "🧩", "🔒",
  "📈", "📊", "🗓️", "⏰", "💬", "❓", "❗", "⚠️",
  "🎨", "🖼️", "🎵", "🌱", "🌍", "🏠", "❤️", "🙂",
];

/** A note's `# ` line as its emoji (one of the picker's, before a space) and its title. */
export function splitHead(head: string): { emoji: string | null; title: string } {
  const emoji = EMOJI.find((each) => head === each || head.startsWith(`${each} `)) ?? null;
  return { emoji, title: emoji ? head.slice(emoji.length).trim() : head };
}
export const headOf = (content: Content) => [content.emoji, content.title].filter(Boolean).join(" ");

/** The note as one Markdown document: its title as the top heading, then its body, as the old app's page. */
const asMarkdown = (content: Content) => (headOf(content) ? `# ${headOf(content)}\n\n${content.body}` : content.body);

/** The note's icon left of its title: a smile to add one, the emoji once chosen. */
export function EmojiButton({ emoji, onChange }: { emoji: string | null; onChange: (emoji: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const pick = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<TooltipIconButton tooltip={emoji ? "Change icon" : "Add icon"} size="icon-md" data-chosen={emoji ? true : undefined} className="note-emoji-button" />}>
        {emoji ? <span aria-hidden className="note-emoji">{emoji}</span> : <SimpleSmile />}
      </PopoverTrigger>
      <PopoverContent align="start" className="p-2">
        <div role="listbox" aria-label="Icons" className="note-emoji-grid">
          {EMOJI.map((choice) => (
            <button key={choice} type="button" role="option" aria-selected={choice === emoji} aria-label={choice} className="note-emoji-choice" onClick={() => pick(choice)}>
              {choice}
            </button>
          ))}
        </div>
        {emoji && (
          <Button size="sm" variant="ghost" className="w-full" onClick={() => pick(null)}>
            Remove icon
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The note's bar, the old app's page bar: the File menu and Insert. `name` is the note's as shown. */
export function NoteTopBar({ content, name, listing, editor, onList, onRename, onDelete }: { content: Content; name: string; listing: boolean; editor: () => LexicalEditor | null; onList: () => void; onRename: () => void; onDelete: () => Promise<string | null> }) {
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const renaming = useRef(false);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2000);
    return () => clearTimeout(timer);
  }, [notice]);
  const copy = () => navigator.clipboard.writeText(asMarkdown(content)).then(() => setNotice("Copied as Markdown"), (error: unknown) => setNotice(`Could not copy: ${String(error)}`));
  // The window's own download asks where, as a file from the web does.
  const download = () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([asMarkdown(content)], { type: "text/markdown" }));
    link.download = `${[...content.title.replace(/[\\/:*?"<>|\n]+/g, " ").trim()].slice(0, 120).join("") || "Untitled note"}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  };
  const item = "note-menu-item";
  return (
    <div data-slot="note-top-bar" className="note-top-bar">
      <DropdownMenu>
        <DropdownMenuTrigger render={<button type="button" aria-label="File menu" className="note-capsule note-file-button" />}>
          <StickyNote aria-hidden className="size-icon-sm" />
          <ChevronDown aria-hidden className="size-icon-sm" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="note-menu"
          // Rename moves into the title once the menu has let go of the focus.
          finalFocus={() => (renaming.current ? ((renaming.current = false), requestAnimationFrame(onRename), false) : true)}
        >
          <DropdownMenuItem className={item} onClick={onList}>
            <StickyNote aria-hidden />
            {listing ? "Hide notes" : "Show notes"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className={item} onClick={() => (renaming.current = true)}>
            <EditPencil aria-hidden />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem className={item} onClick={copy}>
            <Copy aria-hidden />
            Copy as Markdown
          </DropdownMenuItem>
          <DropdownMenuItem className={item} onClick={download}>
            <Download aria-hidden />
            Download
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className={item} variant="destructive" onClick={() => setDeleting(true)}>
            <Trash aria-hidden />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="note-capsule">
        <DropdownMenu>
          <DropdownMenuTrigger render={<TooltipIconButton tooltip="Insert" size="icon-md" className="rounded-full" />}>
            <SquarePlus />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="note-menu note-insert-list" aria-label="Insert options" finalFocus={() => editor()?.getRootElement() ?? true}>
            <div className="note-menu-label">Basic</div>
            {BLOCKS.filter((block) => block.kind !== "paragraph").map((block) => (
              <DropdownMenuItem key={block.kind} className={item} onClick={() => { const now = editor(); if (now) applyBlock(now, block.kind); }}>
                <BlockRow block={block} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {notice && <span role="status" className="note-notice">{notice}</span>}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this note?"
        description={`“${name}” is removed with its chat. This can't be undone.`}
        confirm="Delete"
        destructive
        onConfirm={() => {
          setDeleting(false);
          void onDelete().then((error) => error && setNotice(`Could not delete: ${error}`));
        }}
      />
    </div>
  );
}
