import { lazy, Suspense, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { Input } from "./components/input";
import { TooltipProvider } from "./components/tooltip";
import { search, useDaemon, type View } from "./daemon";
import { Demo } from "./session/Demo";
import "./theme.css";

// A hash change is in-page, so Electron's will-navigate guard lets it through.
const onHash = (listener: () => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};
const useHash = (): string => useSyncExternalStore(onHash, () => window.location.hash);

function App() {
  const { daemon, refused, rows, search: found } = useDaemon();
  const hash = useHash();
  if (hash === "#states") return <Demo />;
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
            <span className="min-w-0 flex-1 truncate">{row.title || row.id}</span>
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

// Dev-only component gallery (pnpm gallery); other builds drop it.
const Gallery = import.meta.env.MODE === "gallery" ? lazy(() => import("../gallery/gallery")) : null;

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    {Gallery ? (
      <Suspense>
        <Gallery />
      </Suspense>
    ) : (
      <App />
    )}
  </TooltipProvider>,
);
