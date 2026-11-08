import { useEffect, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { EmptyState } from "../components/empty-state";
import { ErrorLine } from "../components/error-line";
import { UserBubble } from "../components/thread/message";
import { WorkingLine } from "../components/thread/work";
import { Spinner } from "../icons";
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
  // Off: optimistic, as the real path is. On: the demo acts like an app that waits for the backend.
  const [wait, setWait] = useState(false);
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
        <Thread session={session} wait={wait} />
        <Composer session={session} wait={wait} />
      </section>
      <Controls
        fake={fake}
        session={session}
        reopen={() => setSession(createSession(fake.backend))}
        wait={wait}
        setWait={setWait}
      />
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
    <header className="app-drag flex h-titlebar shrink-0 items-center gap-3 border-b border-divider pe-4">
      <div className="w-traffic-lights shrink-0" />
      <span className="truncate text-sm font-medium">Session states</span>
      {badge === "reconnecting" && (
        <Badge role="status" variant="warning">
          Reconnecting…
        </Badge>
      )}
      {badge === "disconnected" && (
        <Badge role="alert" variant="destructive">
          Disconnected · the background service isn't answering
        </Badge>
      )}
    </header>
  );
}

function Thread({ session, wait }: { session: DemoSession; wait: boolean }) {
  const head = session.useHead();
  const body = bodyState(head);
  const loading = useAfter(body === "loading");
  const shownBody = body === "loading" ? (loading ? "loading" : null) : body;
  useSeen(shownBody);
  return (
    // Reversed, so the scroll stays at the newest row as rows arrive.
    <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
      {/* shrink-0: a full thread grows past the pane and scrolls, instead of spilling under the composer. */}
      <div className="mx-auto flex min-h-full w-full max-w-reading shrink-0 flex-col gap-4 px-6 py-6">
        {shownBody === "loading" && <EmptyState variant="centered" title="Loading the session…" className="m-auto" />}
        {shownBody === "empty" && <EmptyState variant="centered" title="No messages yet" detail="Send one to start." className="m-auto" />}
        {shownBody === "disconnected" && (
          <EmptyState
            variant="centered"
            title="Can't load the session"
            detail="The background service isn't answering, so nothing here can be shown as true."
            className="m-auto"
          />
        )}
        {head.order.map((key) => (
          <EntryView key={key} session={session} entryKey={key} wait={wait} />
        ))}
        <RunLine session={session} />
      </div>
    </div>
  );
}

function EntryView({ session, entryKey, wait }: { session: DemoSession; entryKey: string; wait: boolean }) {
  const entry = session.useEntry(entryKey);
  const state = entry?.pending ? pendingState(entry.pending) : null;
  const slow = useAfter(state === "pending");
  useSeen(state === "pending" ? (slow ? "pending" : null) : state);
  const hidden = wait && (state === "pending" || state === "unknown");
  if (!entry || hidden) return null;
  const { item, pending } = entry;
  if (item.kind !== "message") return <p className="text-sm text-muted-foreground">{item.kind}</p>;
  if (item.role === "assistant") return <p className="text-base font-prose">{item.text}</p>;
  const failed = pending?.status === "unsent" ? "it never reached the agent" : pending?.status === "failed" ? (pending.error ?? "the backend refused it") : undefined;
  return (
    <UserBubble
      keep={entryKey}
      text={item.text}
      time={item.sentAt}
      sending={state === "pending" && slow}
      failed={failed}
      onRetry={() => session.retry(entryKey)}
      onDiscard={() => session.discard(entryKey)}
      unconfirmed={state === "unknown"}
      dimmed={state === "error"}
    />
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
  if (run.state === "error") return <ErrorLine size="sm" error={`The run failed · ${run.error}`} />;
  if (state === "working") return <WorkingLine state="live">Working</WorkingLine>;
  if (state === "stalled") return <WorkingLine state="stalled">Stalled · no output from the agent for a while</WorkingLine>;
  if (state === "interrupted") return <WorkingLine state="interrupted">Interrupted · the run stopped before it finished</WorkingLine>;
  // Muted and still: the link is down, so the run can't be shown as working.
  return <WorkingLine state="disconnected">{`Unknown · last seen ${run.state} ${ago}s ago`}</WorkingLine>;
}

function Composer({ session, wait }: { session: DemoSession; wait: boolean }) {
  const head = session.useHead();
  const [text, setText] = useState("");
  // One id per draft: pressing Send twice can't make two messages.
  const [draftId, setDraftId] = useState(newId);
  const live = head.link === "live";
  const [lastId, setLastId] = useState("");
  const last = session.useEntry(lastId);
  // Waiting for the backend, Send spins until the last send's row arrives or is refused.
  const busy = wait && !!last?.pending && pendingState(last.pending) !== "error";
  const send = () => {
    const words = text.trim();
    if (!words || !live || busy) return;
    session.send(draftId, { text: words }, preview(draftId, words));
    setLastId(draftId);
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
        <Button onClick={send} aria-busy={busy} disabled={!busy && (!live || !text.trim())}>
          {busy && <Spinner className="animate-spin motion-reduce:animate-none" />}
          Send
        </Button>
      </div>
    </div>
  );
}
