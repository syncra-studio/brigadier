import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { SessionOfThread } from "../accounts/limit";
import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { ErrorLine } from "../components/error-line";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/menu";
import { ask, useDaemon } from "../daemon";
import { useHomeDraft, useHomeProject } from "../home/start";
import { History, MinimizeRight } from "../icons/note";
import { ago } from "../panel/words";
import { HOME } from "../shell/tab-store";
import { Chat } from "../icons/thread";
import { ChatCompose } from "../icons/tab";
import { X } from "../icons";
import { daemonRun, failure, SentBubbles, SessionComposer, useSending } from "../session/composer";
import { newId } from "../session/store";
import { Thread, type Source } from "../thread/thread";
import type { Session } from "../thread/item";

type View = "hidden" | "split" | "minimized";
/** The chat's part of the tab's width at first, and how far the divider may go either way, as the old app's. */
const SHARE = 0.5;
const MIN_SHARE = 0.25;
const MAX_SHARE = 0.75;

// Each note's chat view and width while the app runs, as the old app kept them on its tab. By the note's id alone, so
// Home's note keeps them as it comes into the session [D287].
const views = new Map<string, { view: View; share: number }>();

// Each chat's thread as last peeked, so it shows again at once, with no empty column while Rust's comes [D288].
// shortcut: one page per chat, never dropped while the app runs; bound it as daemon.ts's kept threads if chats grow many.
const snapshots = new Map<string, Session>();
const peek = (id: string) =>
  new Promise<Session | null>((done) =>
    ask({ op: "peek", session: id }, (reply) => {
      if (reply.ok) snapshots.set(id, reply.session);
      done(reply.ok ? reply.session : null);
    }),
  );

/**
 * A note with its own chat, as the old app's page tab: the note, and while the chat is open a resizable split with
 * the chat in the half at the end. Folded, the chat is a strip at the tab's edge; hidden, a round button brings it
 * back [D281]. A note on Home has one too, on the new chat's picked agent, and it comes into the session with it [D287].
 */
export function NoteWithChat({ owner, note, offline, onChat, children }: { owner: string; note: string; offline: boolean; onChat: (id: string) => void; children: ReactNode }) {
  const [{ view, share }, setState] = useState(() => views.get(note) ?? { view: "hidden" as View, share: SHARE });
  const set = (next: Partial<{ view: View; share: number }>) =>
    setState((was) => {
      const now = { ...was, ...next };
      views.set(note, now);
      return now;
    });
  // The chat's id, made by Rust on first open.
  const [chat, setChat] = useState<{ id: string } | { error: string } | null>(null);
  // Home's chat runs on what the new chat has picked [D287].
  const { model } = useHomeDraft();
  const project = useHomeProject();
  const pick = owner !== HOME ? [] : model ? ["--backend", model.provider, "--model", model.model, ...(model.effort ? ["--effort", model.effort] : []), ...(project ? ["--project", project.id] : [])] : null;
  // `how`: a new chat, or an earlier one of the session's reopened here [D288].
  const open = (how?: "--new" | { reopen: string }) => {
    set({ view: "split" });
    if (chat && "id" in chat && !how) return;
    if (!pick) return setChat({ error: "Pick a model for the new chat first." });
    // A reopened chat replaces the one shown only once its thread is in, so it never shows empty.
    if (typeof how !== "object") setChat(null);
    const args = typeof how === "object" ? [how.reopen, "--open"] : [newId(), ...(how ? [how] : [])];
    void daemonRun(["note", owner, "chat", note, ...args, ...pick]).then(async (reply) => {
      if (reply.ok && typeof how === "object" && !snapshots.has(reply.chat)) await peek(reply.chat);
      setChat(reply.ok ? { id: reply.chat } : { error: failure(reply) });
      if (reply.ok) onChat(reply.chat);
    });
  };
  // Reopened, the chat it had comes back as it was.
  useEffect(() => {
    if (view !== "hidden" && chat === null) open();
    // Only as the tab first shows.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const row = useRef<HTMLDivElement>(null);
  const id = chat && "id" in chat ? chat.id : null;
  return (
    <div ref={row} data-slot="note-with-chat" className="relative flex min-h-0 min-w-0 flex-1">
      {/* Only split does it take a share; otherwise it leaves the strip its room. */}
      <div data-slot="note-content" data-share={1 - share} className={cx(view === "split" ? "note-share" : "flex-1", "relative flex min-h-0 min-w-0 flex-col")}>
        {children}
        {view === "hidden" && (
          <div className="absolute end-4 bottom-4 z-20">
            <ChatButton id={id} onClick={() => open()} />
          </div>
        )}
      </div>
      {view === "split" && <Divider share={share} row={row} onShare={(next) => set({ share: Math.min(MAX_SHARE, Math.max(MIN_SHARE, next)) })} />}
      {/* Folded or hidden, a made chat stays drawn out of sight at its width, following its thread, so it shows with the split at once [D912]. */}
      {(view === "split" || id) && (
        <div data-slot="note-chat" data-share={share} inert={view !== "split"} className={cx("flex min-h-0 min-w-0 flex-col border-s border-border", view === "split" ? "flex-1" : "note-share-width invisible absolute inset-y-0 end-0")}>
          <div data-slot="note-chat-header" className="flex h-titlebar shrink-0 items-center gap-1 px-2">
            <ChatTitle id={id} />
            <ChatHistory owner={owner} id={id} onOpen={(reopen) => open({ reopen })} />
            <TooltipIconButton tooltip="New chat" onClick={() => open("--new")}>
              <ChatCompose />
            </TooltipIconButton>
            <TooltipIconButton tooltip="Minimize" onClick={() => set({ view: "minimized" })}>
              <MinimizeRight />
            </TooltipIconButton>
            <TooltipIconButton tooltip="Hide chat" onClick={() => set({ view: "hidden" })}>
              <X />
            </TooltipIconButton>
          </div>
          {chat && "error" in chat ? <ErrorLine size="sm" error={chat.error} className="p-4" /> : id && <ChatThread key={id} id={id} offline={offline} />}
        </div>
      )}
      {view === "minimized" && <ChatStrip id={id} onClick={() => open()} />}
    </div>
  );
}

const useChatRow = (id: string | null) => useDaemon().rows?.find((row) => row.id === id);

/** The session's earlier side chats, newest first, each reopened here; shown only when there are some [D288]. */
function ChatHistory({ owner, id, onOpen }: { owner: string; id: string | null; onOpen: (chat: string) => void }) {
  const rows = useDaemon().rows;
  const [kept, setKept] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void daemonRun(["note", owner, "chats"]).then((reply) => live && reply.ok && setKept(reply.chats));
    return () => {
      live = false;
    };
  }, [owner, id]);
  const earlier = (rows ?? []).filter((row) => row.id !== id && kept.includes(row.id)).toSorted((a, b) => b.updated - a.updated);
  if (earlier.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<TooltipIconButton tooltip="History" />}>
        <History />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="note-menu w-64">
        {earlier.map((row) => (
          <DropdownMenuItem key={row.id} className="note-menu-item" onClick={() => onOpen(row.id)}>
            <span className="min-w-0 flex-1 truncate">{row.title || "Chat"}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{ago(row.updated, Date.now())}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChatTitle({ id }: { id: string | null }) {
  return <span className="min-w-0 flex-1 truncate ps-1 text-sm font-medium text-foreground">{useChatRow(id)?.title || "Chat"}</span>;
}

/** The round button that opens the chat; a dot while the hidden chat works. */
function ChatButton({ id, onClick }: { id: string | null; onClick: () => void }) {
  const working = Boolean(useChatRow(id)?.works);
  return (
    <TooltipIconButton tooltip="Chat about this note" side="left" size="icon" variant="secondary" dot={working ? "bg-primary" : undefined} className="size-10 rounded-full bg-composer shadow-hairline backdrop-blur-lg" onClick={onClick}>
      <Chat />
    </TooltipIconButton>
  );
}

/** The folded chat: a strip at the tab's edge with its title and whether it works. */
function ChatStrip({ id, onClick }: { id: string | null; onClick: () => void }) {
  const row = useChatRow(id);
  const title = row?.title || "Chat";
  return (
    <button type="button" data-slot="note-chat-strip" aria-label={`Show chat: ${title}${row?.works ? ", working" : ""}`} onClick={onClick} className="flex w-9 shrink-0 cursor-pointer flex-col items-center gap-2 border-s border-border py-3 text-xs text-muted-foreground hover:bg-fill">
      <Chat className="size-4" />
      <span className="min-h-0 truncate note-vertical">{title}</span>
      {row?.works && <span className="note-vertical">Working…</span>}
    </button>
  );
}

/** The split's divider: drag it, or use the arrow keys, to share the width differently. */
function Divider({ share, row, onShare }: { share: number; row: React.RefObject<HTMLDivElement | null>; onShare: (share: number) => void }) {
  const [dragging, setDragging] = useState(false);
  const shareAt = (x: number) => {
    const box = row.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return share;
    const rtl = getComputedStyle(row.current!).direction === "rtl";
    return (rtl ? x - box.left : box.right - x) / box.width;
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat"
      aria-valuenow={Math.round(share * 100)}
      aria-valuemin={MIN_SHARE * 100}
      aria-valuemax={MAX_SHARE * 100}
      tabIndex={0}
      data-resizing={dragging || undefined}
      className="group/resize relative z-10 -mx-1 flex w-resize-handle shrink-0 cursor-col-resize justify-center outline-none"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => dragging && onShare(shareAt(event.clientX))}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onKeyDown={(event) => {
        const step = event.key === "ArrowLeft" ? 0.05 : event.key === "ArrowRight" ? -0.05 : 0;
        if (!step) return;
        event.preventDefault();
        onShare(share + (getComputedStyle(event.currentTarget).direction === "rtl" ? -step : step));
      }}
    >
      <span className="w-px bg-input opacity-0 transition-opacity group-hover/resize:opacity-100 group-focus-visible/resize:opacity-100 group-data-resizing/resize:opacity-100" />
    </div>
  );
}

/**
 * The chat's thread and composer: Rust's snapshot of it, asked again each time its row changes, as the Workers
 * panel reads a worker's, so the session's own thread stays the one the app follows.
 */
function ChatThread({ id, offline }: { id: string; offline: boolean }) {
  const row = useChatRow(id);
  const source = useMemo(() => {
    let session = snapshots.get(id) ?? null;
    const listeners = new Set<() => void>();
    return {
      subscribe: (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener)),
      get: () => session,
      set(next: Session) {
        session = next;
        for (const listener of listeners) listener();
      },
    } satisfies Source & { set(next: Session): void };
  }, [id]);
  const updated = row?.updated;
  useEffect(() => {
    let live = true;
    void peek(id).then((session) => live && session && source.set(session));
    return () => {
      live = false;
    };
  }, [id, updated, source]);
  const shown = useSyncExternalStore(source.subscribe, source.get);
  // A message on its way shows under the thread until Rust's has it, as the session's does.
  const sending = useSending(id);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 px-4 pt-4">
        {shown && (
          <SessionOfThread value={{ id, offline }}>
            <Thread id={id} source={source} footer={sending && <SentBubbles id={id} source={source} />} />
          </SessionOfThread>
        )}
      </div>
      <SessionComposer id={id} row={row} offline={offline} source={source} />
    </div>
  );
}
