import { useCallback, useEffect, useState } from "react";

import { ConfirmDialog } from "../components/confirm-dialog";
import { TooltipIconButton } from "../components/icon-button";
import { Input } from "../components/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/menu";
import { DotsHorizontal, Plus } from "../icons";
import { Pin, Unpin } from "../icons/sidebar";
import { Document } from "../icons/tab";
import { EditPencil, Trash } from "../icons/thread";
import { ago } from "../panel/words";
import { setNoteTitle, UNTITLED_NOTE } from "../shell/note-tab";
import { splitHead } from "./top-bar";
import { useNoteChanges } from "./run";
import type { daemonRun } from "../session/composer";

/** A note as `note list` gives it: its name and `# ` line, the line under the name, and the line a search matched. */
export type Listed = { id: string; title: string; head: string; preview: string; at: number; pinned: boolean; match: string | null };

/** Waits this long after typing before the search is asked, so each letter doesn't cost a read of every note. */
const SEARCH_AFTER_MS = 120;

/**
 * The project's notes beside the open one, as Apple Notes' and Bear's list [D913 D921]: pinned first, then the newest,
 * each with its first line; the search reads every note's whole text and shows the line it matched. A row is renamed
 * where it is (double-click, its ⋯ or File › Rename), pinned or deleted from its ⋯.
 */
export function NotesColumn({
  note,
  run,
  renaming,
  onRenaming,
  onOpen,
  onNew,
  onRenameOpen,
  onDeleteOpen,
}: {
  note: string;
  run: typeof daemonRun;
  renaming: string | null;
  onRenaming: (id: string | null) => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRenameOpen: (name: string) => void;
  onDeleteOpen: () => void;
}) {
  const [notes, setNotes] = useState<Listed[] | null>(null);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const [deleting, setDeleting] = useState<Listed | null>(null);
  const [version, setVersion] = useState(0);
  useNoteChanges(useCallback(() => setVersion((n) => n + 1), []));
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => void run(["list", ...(query.trim() ? ["--q", query.trim()] : [])]).then((reply) => live && setNotes(reply.ok ? reply.notes : [])), query ? SEARCH_AFTER_MS : 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [run, query, version]);
  const shown = notes ?? [];
  const rename = (row: Listed, name: string) => {
    onRenaming(null);
    if (name.trim() === row.title) return;
    if (row.id === note) return onRenameOpen(name.trim());
    void run(["rename", row.id, name.trim()]).then((reply) => reply.ok && setNoteTitle(row.id, reply.title));
  };
  return (
    <aside aria-label="Notes" className="note-list-column">
      <div className="note-list-search">
        <Input
          aria-label="Search notes"
          placeholder="Search notes"
          value={query}
          onChange={(event) => (setQuery(event.target.value), setAt(0))}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") (event.preventDefault(), setAt((index) => Math.min(index + 1, shown.length - 1)));
            if (event.key === "ArrowUp") (event.preventDefault(), setAt((index) => Math.max(index - 1, 0)));
            if (event.key === "Enter" && shown[at]) (event.preventDefault(), onOpen(shown[at].id));
          }}
        />
        <TooltipIconButton tooltip="New note" onClick={onNew}>
          <Plus />
        </TooltipIconButton>
      </div>
      <ul aria-label="Notes" className="note-list">
        {notes && !shown.length && <li className="note-list-empty">{query ? "No notes match." : "No notes yet."}</li>}
        {shown.map((row, index) => {
          const { emoji } = splitHead(row.head);
          const title = row.title || UNTITLED_NOTE;
          return (
            <li key={row.id} className="note-list-item" data-at={index === at || undefined}>
              {renaming === row.id ? (
                <Input
                  aria-label="Note name"
                  autoFocus
                  defaultValue={row.title}
                  onFocus={(event) => event.currentTarget.select()}
                  onBlur={(event) => rename(row, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") rename(row, event.currentTarget.value);
                    if (event.key === "Escape") (event.preventDefault(), onRenaming(null));
                  }}
                />
              ) : (
                <button type="button" tabIndex={-1} aria-current={row.id === note || undefined} className="note-list-row" onMouseEnter={() => setAt(index)} onClick={() => onOpen(row.id)} onDoubleClick={() => onRenaming(row.id)}>
                  <span className="note-list-line">
                    {emoji ? <span aria-hidden className="note-list-emoji">{emoji}</span> : <Document aria-hidden className="size-icon-sm shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
                    {row.pinned && <Pin aria-label="Pinned" className="size-icon-sm shrink-0 text-muted-foreground" />}
                  </span>
                  {/* The time leads the line under the name, as Apple Notes' list, so the name keeps its room. */}
                  <span className="note-list-preview">
                    <span className="note-list-ago">{ago(row.at, Date.now())}</span>
                    {row.preview}
                  </span>
                  {row.match && <span className="note-list-match">{row.match}</span>}
                </button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger render={<TooltipIconButton tooltip="More" size="icon-sm" className="note-list-more" />}>
                  <DotsHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="note-menu" finalFocus={false}>
                  <DropdownMenuItem className="note-menu-item" onClick={() => requestAnimationFrame(() => onRenaming(row.id))}>
                    <EditPencil aria-hidden />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem className="note-menu-item" onClick={() => void run(["pin", row.id, row.pinned ? "off" : "on"])}>
                    {row.pinned ? <Unpin aria-hidden /> : <Pin aria-hidden />}
                    {row.pinned ? "Unpin" : "Pin"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="note-menu-item" variant="destructive" onClick={() => setDeleting(row)}>
                    <Trash aria-hidden />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this note?"
        description={`“${deleting?.title || UNTITLED_NOTE}” is removed with its chat. This can't be undone.`}
        confirm="Delete"
        destructive
        onConfirm={() => {
          const row = deleting;
          setDeleting(null);
          if (row?.id === note) onDeleteOpen();
          else if (row) void run(["delete", row.id]);
        }}
      />
    </aside>
  );
}
