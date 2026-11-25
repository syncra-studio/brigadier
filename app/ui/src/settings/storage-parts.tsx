import { useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { cx } from "../components/cx";
import { SettingsCard } from "../components/settings-card";
import { Skeleton } from "../components/skeleton";
import { StateDot } from "../components/state-dot";
import { Branch, ChevronRight, Reload } from "../icons";
import { WorkerGlyph } from "../icons/worker-glyphs";
import { type Chat, type Holder, KINDS, type Kind, PER_CHAT, SOME, type Storage, gb } from "./storage-data";

export const titleOf = (holder: Holder) => holder.title || "New session";

/** A size at a row's end, or a grey block until it is counted. */
export function Size({ value, ready = true, className }: { value: number; ready?: boolean; className?: string }) {
  if (!ready) return <Skeleton className="h-4 w-14" />;
  return <span className={cx("shrink-0 text-label tabular-nums", className)}>{gb(value)}</span>;
}

/** Kinds side by side, each as wide as its share; `rest` is the empty end of the track. */
export function ShareBar({ parts, rest = 0, thin = false, label }: { parts: { kind: Kind; size: number }[]; rest?: number; thin?: boolean; label: string }) {
  return (
    <div role="img" aria-label={label} className={cx("flex w-full gap-px overflow-hidden rounded-capsule bg-muted", thin ? "h-1" : "h-2.5")}>
      {parts
        .filter((part) => part.size >= SOME)
        .map(({ kind, size }) => (
          <span key={kind} data-share={size} className={cx("storage-share h-full", KINDS.find((each) => each.kind === kind)!.fill)} />
        ))}
      {rest > 0 && <span data-share={rest} className="storage-share h-full" />}
    </div>
  );
}

export function TotalBar({ storage }: { storage: Storage }) {
  const parts = KINDS.filter(({ kind }) => storage.ready(kind)).map(({ kind }) => ({ kind, size: storage.kindSize(kind) }));
  return <ShareBar label="What Brigadier uses, by kind" parts={parts} rest={storage.counting ? storage.total / 2 + 4e9 : 0} />;
}

/** Counts it all again. */
export function Recount({ storage, online }: { storage: Storage; online: boolean }) {
  return (
    <Button variant="soft" size="sm" disabled={storage.counting || storage.freeing !== null || !online} onClick={storage.recount}>
      <Reload aria-hidden className={storage.counting ? "animate-spin motion-reduce:animate-none" : undefined} />
      Count again
    </Button>
  );
}

/** What a chat or worker is, said where it matters for what Free up space takes. */
export function Marks({ holder }: { holder: Holder }) {
  return (
    <>
      {holder.working && (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-quiet-foreground">
          <StateDot tone="ready" />
          Working
        </span>
      )}
      {holder.unmerged && <Badge variant="outline">Unmerged work</Badge>}
      {holder.archived && !holder.worker && <Badge variant="secondary">Archived</Badge>}
    </>
  );
}

const workersOf = ({ workers }: Chat) => (workers.length === 0 ? "no workers" : workers.length === 1 ? "1 worker" : `${workers.length} workers`);
const chatLine = (chat: Chat) => `${chat.project ?? "Chats"} · ${workersOf(chat)}`;

/** The chats, largest first, each with its kinds against the largest's; one with workers opens to them. */
export function ChatList({ storage }: { storage: Storage }) {
  const ready = !storage.counting;
  if (!ready) return <CountingRows />;
  const largest = Math.max(...storage.chats.map((chat) => storage.chatSize(chat)));
  const smaller = storage.smaller.length;
  return (
    <SettingsCard>
      {storage.chats.map((chat, at) => (
        <ChatRow key={chat.id} chat={chat} storage={storage} largest={largest} first={at === 0} />
      ))}
      {smaller > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 text-quiet-foreground">
          <span className="flex-1 text-label">
            {smaller} smaller {smaller === 1 ? "chat" : "chats"}
          </span>
          <Size value={storage.rest} />
        </div>
      )}
    </SettingsCard>
  );
}

function ChatRow({ chat, storage, largest, first }: { chat: Chat; storage: Storage; largest: number; first: boolean }) {
  const [open, setOpen] = useState(first);
  const total = storage.chatSize(chat);
  const has = chat.workers.length > 0;
  const workers = [...chat.workers].sort((a, b) => storage.holderSize(b) - storage.holderSize(a));
  const inside = (
    <>
      <span className="flex size-icon-md shrink-0 items-center justify-center text-quiet-foreground">
        {has ? <ChevronRight className={cx("size-icon-sm transition-transform motion-reduce:transition-none", open && "rotate-90")} /> : <Branch aria-hidden className="size-icon-md" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-label font-medium">{titleOf(chat)}</span>
          <Marks holder={chat} />
        </span>
        <span className="truncate text-xs text-quiet-foreground">{chatLine(chat)}</span>
        <span className="block pt-1">
          <ShareBar thin label={`${titleOf(chat)}, by kind`} parts={PER_CHAT.map((kind) => ({ kind, size: storage.chatSize(chat, kind) }))} rest={largest - total} />
        </span>
      </span>
      <Size value={total} />
    </>
  );
  if (!has) return <div className="flex items-center gap-3 px-4 py-3">{inside}</div>;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-start hover:bg-fill-faint focus-visible:focus-ring">{inside}</CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col pb-2">
          <li className="flex items-center gap-3 py-1.5 ps-11 pe-4">
            <Branch aria-hidden className="size-icon-md shrink-0 text-quiet-foreground" />
            <span className="min-w-0 flex-1 truncate text-label text-quiet-foreground">The chat itself</span>
            <Size value={storage.holderSize(chat)} className="text-quiet-foreground" />
          </li>
          {workers.map((worker) => (
            <li key={worker.id} className="flex items-center gap-3 py-1.5 ps-11 pe-4">
              <WorkerGlyph id={worker.id} className="size-icon-md" />
              <span className="min-w-0 truncate text-label">{titleOf(worker)}</span>
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <Marks holder={worker} />
              </span>
              <Size value={storage.holderSize(worker)} className="text-quiet-foreground" />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function CountingRows() {
  return (
    <SettingsCard aria-busy>
      {[0, 1, 2, 3].map((n) => (
        <div key={n} className="flex items-center gap-3 px-4 py-3.5">
          <Skeleton className="size-icon-md" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-14" />
        </div>
      ))}
    </SettingsCard>
  );
}

/** What Free up space never takes. */
export function Stays() {
  return <p className="text-xs text-quiet-foreground">Chats, unmerged work, branches and anything a working agent uses stay.</p>;
}
