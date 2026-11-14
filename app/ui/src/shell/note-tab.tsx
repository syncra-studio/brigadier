import type { LexicalEditor } from "lexical";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "../components/button";
import { ErrorLine } from "../components/error-line";
import { useDaemon } from "../daemon";
import { daemonRun, failure } from "../session/composer";
import { newId } from "../session/store";
import { NoteWithChat } from "../note/chat";
import { NoteEditor, focusNoteStart } from "../note/editor";
import { EmojiButton, headOf, NoteTopBar, splitHead } from "../note/top-bar";
import "../note/page.css";
import { HOME, closeTab, openTab } from "./tab-store";

/** What a note with nothing written yet is called, by its tab and the New tab. */
export const UNTITLED_NOTE = "Untitled note";
/** How long typing rests before an edit is kept, as the old app's. */
const KEEP_AFTER_MS = 500;

// Each note's name as Rust last gave it, by `<owner>/<note>`, for its tab [D244].
const titles = new Map<string, string>();
const listeners = new Set<() => void>();
export function setNoteTitle(owner: string, note: string, title: string): void {
  titles.set(`${owner}/${note}`, title);
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener));
export const useNoteTitle = (owner: string, note: string) => useSyncExternalStore(subscribe, () => titles.get(`${owner}/${note}`)) || UNTITLED_NOTE;

/** A note as Rust keeps it: its `# ` line as an emoji and a title, its body, and the revision read. */
export type Content = { emoji: string | null; title: string; body: string };
type Read = Content & { revision: string; chat: string | null };
const readOf = (reply: Record<string, any>): Read => ({ ...splitHead(reply.head), body: reply.body, revision: reply.revision, chat: reply.chat ?? null });

/**
 * A session's note as the old app's page in a tab: its emoji and title over its body, rich text kept by Rust as
 * Markdown once typing rests, and a side chat beside it that can write it [D244, D281]. What the chat writes shows
 * at once; typing it would overwrite is asked about, as the old app's conflict banner did.
 */
export function NoteTab({ owner, note, tabId, active }: { owner: string; note: string; tabId: string; active: boolean }) {
  const offline = useDaemon().daemon === null;
  const [read, setRead] = useState<Read | { error: string } | null>(null);
  // Bumped to load content that changed outside the editor.
  const [version, setVersion] = useState(0);
  const [content, setContent] = useState<Content>({ emoji: null, title: "", body: "" });
  const [conflict, setConflict] = useState<Read | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = useRef<string | null>(null);
  const pending = useRef<Content | null>(null);
  const latest = useRef(content);
  latest.current = content;
  const writes = useRef(Promise.resolve());
  const timer = useRef<number | undefined>(undefined);
  const editor = useRef<LexicalEditor | null>(null);
  const titleField = useRef<HTMLTextAreaElement | null>(null);
  const take = useCallback((next: Read) => {
    base.current = next.revision;
    setContent({ emoji: next.emoji, title: next.title, body: next.body });
    setVersion((n) => n + 1);
  }, []);
  // Read as the tab shows and again whenever its chat moves: what the chat wrote comes in unless typing waits.
  const chat = useDaemon().rows?.find((row) => row.id === (read && "chat" in read ? read.chat : null));
  const chatMoved = chat?.updated;
  useEffect(() => {
    if (!active && read !== null) return;
    let live = true;
    void daemonRun(["note", owner, "read", note]).then((reply) => {
      if (!live) return;
      if (!reply.ok) return setRead((was) => was ?? { error: failure(reply) });
      setNoteTitle(owner, note, reply.title);
      const next = readOf(reply);
      setRead(next);
      if (next.revision === base.current) return;
      if (pending.current) setConflict(next);
      else take(next);
    });
    return () => {
      live = false;
    };
    // `read` only says whether it was read yet.
  }, [owner, note, active, chatMoved, take]); // eslint-disable-line react-hooks/exhaustive-deps
  // One write after another, each on the revision the last left, so nothing is ever overwritten unseen.
  const keep = useCallback(() => {
    window.clearTimeout(timer.current);
    const next = pending.current;
    if (next === null) return;
    pending.current = null;
    writes.current = writes.current.then(() =>
      daemonRun(["note", owner, "write", note, headOf(next), next.body, ...(base.current === null ? [] : ["--base", base.current])]).then((reply) => {
        if (reply.ok) {
          base.current = reply.revision;
          setNoteTitle(owner, note, reply.title);
          return setError(null);
        }
        // Not kept: it goes with the next edit, unless a newer one went meanwhile.
        if (latest.current === next) pending.current ??= next;
        if (reply.conflict) return setConflict(readOf(reply));
        setError(String(reply.error ?? "Couldn't keep this edit."));
      }),
    );
  }, [owner, note]);
  // Leaving the tab keeps the edit at once.
  useEffect(() => {
    if (!active) keep();
  }, [active, keep]);
  useEffect(() => keep, [keep]);
  useEffect(() => {
    if (read && "revision" in read && base.current === null) take(read);
  }, [read, take]);
  // A new note starts in its title.
  const fresh = read !== null && "revision" in read && !read.title && !read.body;
  useEffect(() => {
    if (active && fresh) titleField.current?.focus();
  }, [active, fresh]);

  if (read === null) return <div aria-busy className="flex-1" />;
  if ("error" in read) return <ErrorLine size="sm" error={read.error} className="m-auto" />;
  const change = (next: Partial<Content>) => {
    const now = { ...latest.current, ...next };
    setContent(now);
    latest.current = pending.current = now;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(keep, KEEP_AFTER_MS);
  };
  const keepMine = () => {
    if (!conflict) return;
    base.current = conflict.revision;
    pending.current = latest.current;
    setConflict(null);
    keep();
  };
  const useTheirs = () => {
    if (!conflict) return;
    pending.current = null;
    take(conflict);
    setConflict(null);
  };
  const keepBoth = () => {
    if (!conflict) return;
    const copy = newId();
    const mine = { ...latest.current, title: latest.current.title ? `${latest.current.title} (copy)` : "" };
    void daemonRun(["note", owner, "write", copy, headOf(mine), mine.body]).then((reply) => (reply.ok ? openTab(owner, "note", copy) : setError(failure(reply))));
    useTheirs();
  };
  return (
    <NoteWithChat owner={owner === HOME ? null : owner} note={note} offline={offline} onChat={(chat) => setRead((was) => (was && "revision" in was ? { ...was, chat } : was))}>
      <div data-slot="note-tab" className="note-tab">
        <NoteTopBar
          owner={owner}
          content={content}
          editor={() => editor.current}
          onRename={() => {
            titleField.current?.focus();
            titleField.current?.select();
          }}
          onDelete={() =>
            daemonRun(["note", owner, "delete", note]).then((reply) => {
              if (!reply.ok) return failure(reply);
              pending.current = null;
              closeTab(owner, tabId);
              return null;
            })
          }
        />
        {conflict && (
          <Banner text="This note changed elsewhere. Which version do you want to keep?">
            <Button size="sm" variant="ghost" onClick={keepMine}>Keep mine</Button>
            <Button size="sm" variant="ghost" onClick={useTheirs}>Use theirs</Button>
            <Button size="sm" variant="ghost" onClick={keepBoth}>Keep both</Button>
          </Banner>
        )}
        {error && !conflict && (
          <Banner tone="error" text={`Your last changes aren't saved yet: ${error}. They're kept here and saved with your next edit.`}>
            <Button size="sm" variant="ghost" onClick={() => ((pending.current ??= latest.current), keep())}>Try again</Button>
          </Banner>
        )}
        <div className="note-scroll">
          <div className="note-column">
            <div className="note-heading">
              <EmojiButton emoji={content.emoji} onChange={(emoji) => change({ emoji })} />
              <textarea
                ref={titleField}
                aria-label="Note title"
                placeholder={UNTITLED_NOTE}
                rows={1}
                spellCheck
                className="note-title"
                value={content.title}
                onChange={(event) => change({ title: event.target.value.replaceAll("\n", " ") })}
                onKeyDown={(event) => {
                  const atEnd = event.currentTarget.selectionStart === event.currentTarget.value.length;
                  if (event.key === "Enter" || (event.key === "ArrowDown" && atEnd)) {
                    event.preventDefault();
                    if (editor.current) focusNoteStart(editor.current);
                  }
                }}
              />
            </div>
            <NoteEditor key={version} body={content.body} label={content.title || UNTITLED_NOTE} editorRef={editor} onChange={(body) => body !== latest.current.body && change({ body })} />
          </div>
        </div>
      </div>
    </NoteWithChat>
  );
}

/** A line over the note: what happened, and what can be done about it. */
function Banner({ text, tone = "warning", children }: { text: string; tone?: "warning" | "error"; children: React.ReactNode }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} data-tone={tone} className={`mx-auto flex w-full max-w-184 shrink-0 items-center gap-2 rounded-alert px-3 py-1.5 text-label ${tone === "error" ? "bg-destructive-wash" : "bg-warning-wash"}`}>
      <span className="min-w-0 flex-1">{text}</span>
      {children}
    </div>
  );
}
