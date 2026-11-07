import { useEffect, useState, type ReactNode } from "react";

import type { Item } from "../thread/item";
import { Controls, useSeen } from "./Controls";
import { createFake, preview, type FakeCommand } from "./fake";
import { bodyState, linkState, pendingState, runState, useAfter, useNow } from "./shown";
import { createSession, newId, type Session } from "./store";

type DemoSession = Session<Item, FakeCommand>;

// Lives as long as the page, as the daemon outlives a window.
const fake = createFake();

export function Demo() {
  const [session, setSession] = useState(() => createSession(fake.backend));
  useEffect(() => {
    session.connect();
    return () => {
      session.close();
      fake.close();
    };
  }, [session]);
  return (
    <main className="fixed inset-0 flex">
      <section className="flex min-w-0 flex-1 flex-col">
        <Header session={session} />
        <Thread session={session} />
        <Composer session={session} />
      </section>
      <Controls fake={fake} session={session} reopen={() => setSession(createSession(fake.backend))} />
    </main>
  );
}

function Header({ session }: { session: DemoSession }) {
  const head = session.useHead();
  const link = linkState(head);
  // A blip shows no badge; a real outage does. Disconnected is never a blip.
  const reconnecting = useAfter(link === "reconnecting");
  const badge = link === "disconnected" ? "disconnected" : reconnecting ? "reconnecting" : null;
  useSeen(badge);
  return (
    <header className="app-drag flex h-titlebar shrink-0 items-center gap-2 border-b border-divider ps-traffic-lights pe-4">
      <span className="truncate text-sm font-medium">Session states</span>
      {badge === "reconnecting" && (
        <span role="status" className="rounded-capsule bg-warning/15 px-2 py-0.5 text-xs text-warning">
          Reconnecting…
        </span>
      )}
      {badge === "disconnected" && (
        <span role="alert" className="rounded-capsule bg-destructive/15 px-2 py-0.5 text-xs text-destructive">
          Disconnected · the background service isn't answering
        </span>
      )}
    </header>
  );
}

function Thread({ session }: { session: DemoSession }) {
  const head = session.useHead();
  const body = bodyState(head);
  const loading = useAfter(body === "loading");
  const shownBody = body === "loading" ? (loading ? "loading" : null) : body;
  useSeen(shownBody);
  return (
    // Reversed, so the scroll stays at the newest row as rows arrive.
    <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-reading flex-col gap-4 px-6 py-6">
        {shownBody === "loading" && <Placeholder title="Loading the session…" />}
        {shownBody === "empty" && <Placeholder title="No messages yet" line="Send one to start." />}
        {shownBody === "disconnected" && (
          <Placeholder title="Can't load the session" line="The background service isn't answering, so nothing here can be shown as true." />
        )}
        {head.order.map((key) => (
          <EntryView key={key} session={session} entryKey={key} />
        ))}
        <RunLine session={session} />
      </div>
    </div>
  );
}

function Placeholder({ title, line }: { title: string; line?: string }) {
  return (
    <div role="status" className="m-auto flex flex-col items-center gap-1 text-center">
      <p className="text-base font-medium text-muted-foreground">{title}</p>
      {line && <p className="text-sm text-muted-foreground">{line}</p>}
    </div>
  );
}

function EntryView({ session, entryKey }: { session: DemoSession; entryKey: string }) {
  const entry = session.useEntry(entryKey);
  const state = entry?.pending ? pendingState(entry.pending) : null;
  const slow = useAfter(state === "pending");
  useSeen(state === "pending" ? (slow ? "pending" : null) : state);
  if (!entry) return null;
  const { item, pending } = entry;
  if (item.kind !== "message") return <p className="text-sm text-muted-foreground">{item.kind}</p>;
  if (item.role === "assistant") return <p className="text-base font-prose">{item.text}</p>;
  const refused = pending?.status === "failed" || pending?.status === "unsent";
  return (
    <div className="flex flex-col items-end gap-1">
      <div className={`max-w-full min-w-0 rounded-overlay bg-muted px-4 py-2.5 text-base ${refused ? "opacity-50" : ""}`}>{item.text}</div>
      {state === "pending" && slow && <Note>Sending…</Note>}
      {state === "unknown" && <Note>Not confirmed · it's checked once the link is back</Note>}
      {refused && pending && (
        <div role="alert" className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs">
          <span className="text-destructive">
            {pending.status === "unsent" ? "Not sent · it never reached the agent" : `Not sent · ${pending.error}`}
          </span>
          <button type="button" onClick={() => session.retry(entryKey)} className="text-foreground hover:text-foreground/80">
            Try again
          </button>
          <button type="button" onClick={() => session.discard(entryKey)} className="text-muted-foreground hover:text-foreground">
            Discard
          </button>
        </div>
      )}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-xs text-muted-foreground">
      {children}
    </p>
  );
}

function RunLine({ session }: { session: DemoSession }) {
  const head = session.useHead();
  const state = runState(head);
  const now = useNow(state === "unknown");
  useSeen(state === "working" ? null : state);
  if (state === null) return null;
  const run = head.run;
  const ago = Math.max(0, Math.round((now - (head.downSince ?? now)) / 1000));
  return (
    <div role="status" className="text-sm">
      {state === "working" && <span className="shimmer">Working</span>}
      {state === "stalled" && <span className="text-warning">Stalled · no output from the agent for a while</span>}
      {state === "interrupted" && <span className="text-muted-foreground">Interrupted · the run stopped before it finished</span>}
      {run.state === "error" && <span className="text-destructive">The run failed · {run.error}</span>}
      {state === "unknown" && <span className="text-muted-foreground">Unknown · last seen {run.state} {ago}s ago</span>}
    </div>
  );
}

function Composer({ session }: { session: DemoSession }) {
  const head = session.useHead();
  const [text, setText] = useState("");
  // One id per draft: pressing Send twice can't make two messages.
  const [draftId, setDraftId] = useState(newId);
  const live = head.link === "live";
  const send = () => {
    const words = text.trim();
    if (!words || !live) return;
    session.send(draftId, { text: words }, preview(draftId, words));
    setText("");
    setDraftId(newId());
  };
  return (
    <div className="mx-auto w-full max-w-reading shrink-0 px-6 pb-6">
      <div className="flex items-end gap-2 rounded-overlay border border-border bg-card p-3 shadow-raised">
        <textarea
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter that ends an IME composition is the composition's, not Send's.
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            send();
          }}
          placeholder={live ? "Message the agent" : "Waiting for the link to come back"}
          className="min-h-control-md flex-1 resize-none bg-transparent px-1 py-1.5 text-base outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          onClick={send}
          disabled={!live || !text.trim()}
          className="h-control-md rounded-capsule bg-primary px-4 text-label font-medium text-primary-fg disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}
