import { lazy, Suspense, useEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { Input } from "./components/input";
import { WorkingLine } from "./components/thread/work";
import { TooltipProvider } from "./components/tooltip";
import { openThread, search, threadSource, useDaemon, useThread, type View } from "./daemon";
import { Demo } from "./session/Demo";
import { TerminalPane } from "./terminal/terminal";
import { Thread } from "./thread/thread";
import "./theme.css";

// A hash change is in-page, so Electron's will-navigate guard lets it through.
const onHash = (listener: () => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};
const useHash = (): string => useSyncExternalStore(onHash, () => window.location.hash);

// The screen that was open comes back when the app reopens.
if (!window.location.hash) window.location.hash = localStorage.getItem("route") ?? "";
window.addEventListener("hashchange", () => localStorage.setItem("route", window.location.hash));

function App() {
  const { daemon, refused, rows, search: found } = useDaemon();
  const hash = useHash();
  if (hash === "#states") return <Demo />;
  if (hash.startsWith("#thread/")) {
    const id = decodeURIComponent(hash.slice("#thread/".length));
    const row = rows?.find((each) => each.id === id);
    return <SessionThread id={id} title={row?.title} stalled={row?.state === "stalled"} offline={daemon === null} />;
  }
  return (
    <main className="fixed inset-0 flex flex-col items-center gap-2 overflow-y-auto pt-titlebar">
      <div className="app-drag fixed inset-x-0 top-0 h-titlebar" />
      <h1 className="font-display text-hero font-semibold">Brigadier</h1>
      {daemon && (
        <p className="text-sm text-muted-foreground">
          Daemon connected · pid {daemon.pid} · version {daemon.version}
        </p>
      )}
      {daemon === null && <p className="text-sm text-destructive">{refused ?? "Daemon not reachable · reconnecting…"}</p>}
      <a href="#states" className="text-sm text-muted-foreground hover:text-foreground">
        Session states
      </a>
      <Sessions rows={rows} found={found} offline={daemon === null} />
    </main>
  );
}

// The smallest list that proves the daemon path: plain rows, every state shown.
function Sessions({ rows, found, offline }: { rows: View["rows"]; found: View["search"]; offline: boolean }) {
  const shown = found.ids && rows?.filter((row) => found.ids!.includes(row.id));
  const list = shown ?? rows;
  return (
    <section className="flex w-full max-w-reading flex-col gap-2 px-4">
      <Input placeholder="Search sessions" value={found.q} onChange={(event) => search(event.target.value)} />
      {found.slow && <p className="text-sm text-muted-foreground">Searching…</p>}
      {found.error && <p className="text-sm text-destructive">{found.error}</p>}
      {rows === undefined && <p className="text-sm text-muted-foreground">Loading sessions…</p>}
      {rows?.length === 0 && <p className="text-sm text-muted-foreground">No sessions</p>}
      {rows?.length !== 0 && shown?.length === 0 && !found.slow && <p className="text-sm text-muted-foreground">No matches</p>}
      <ul className={offline ? "text-sm text-muted-foreground" : "text-sm"}>
        {list?.map((row) => (
          <li key={row.id} className="flex gap-2 py-1">
            <a href={`#thread/${encodeURIComponent(row.id)}`} className="min-w-0 flex-1 truncate hover:underline">
              {row.title || row.id}
            </a>
            <span className={row.error ? "text-destructive" : "text-muted-foreground"}>{row.error ?? row.state}</span>
            <span className="text-muted-foreground">
              {row.backend} · {row.id}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// One session's thread, straight from Rust's fold [D64, D65]; the view draws it, with no folding here.
// Its terminal sits beside it, on the same conversation [D47].
function SessionThread({ id, title, stalled, offline }: { id: string; title: string | undefined; stalled: boolean; offline: boolean }) {
  useEffect(() => openThread(id), [id]);
  const state = useThread();
  return (
    <main className="fixed inset-0 flex flex-col">
      <header className="flex h-titlebar shrink-0 items-center gap-3 text-sm">
        <div className="app-drag h-full w-traffic-lights shrink-0" />
        <a href="#" className="text-muted-foreground hover:text-foreground">
          Sessions
        </a>
        <span className="app-drag flex h-full min-w-0 flex-1 items-center truncate">{title || id}</span>
      </header>
      {offline && <p className="text-center text-sm text-muted-foreground">Daemon not reachable · reconnecting…</p>}
      <div className="flex min-h-0 flex-1">
        {state?.status === "missing" ? (
          <p className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Session not found</p>
        ) : state?.status === "error" ? (
          <p className="flex flex-1 items-center justify-center text-sm text-destructive">{state.error}</p>
        ) : (
          <div className={`min-h-0 min-w-0 flex-1 ${offline ? "opacity-disabled" : ""}`}>
            <Thread source={threadSource} footer={stalled && <WorkingLine state="stalled">Stalled · no output from the agent for a while</WorkingLine>} />
          </div>
        )}
        {state?.status !== "missing" && <TerminalPane id={id} />}
      </div>
    </main>
  );
}

// Dev-only component gallery (pnpm gallery); other builds drop it.
const Gallery = import.meta.env.MODE === "gallery" ? lazy(() => import("../gallery/gallery")) : null;
// `pnpm thread` builds the thread demo in place of the app.
const ThreadDemo = import.meta.env.VITE_SCREEN === "thread" ? lazy(() => import("./thread/demo").then(({ Demo }) => ({ default: Demo }))) : null;
const Screen = Gallery ?? ThreadDemo;

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    {Screen ? (
      <Suspense>
        <Screen />
      </Suspense>
    ) : (
      <App />
    )}
  </TooltipProvider>,
);
