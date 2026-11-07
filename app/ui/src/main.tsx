import { lazy, Suspense, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { TooltipProvider } from "./components/tooltip";
import { useDaemon } from "./daemon";
import { Demo } from "./session/Demo";
import "./theme.css";

// A hash change is in-page, so Electron's will-navigate guard lets it through.
const onHash = (listener: () => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};
const useHash = (): string => useSyncExternalStore(onHash, () => window.location.hash);

function App() {
  const daemon = useDaemon();
  const hash = useHash();
  if (hash === "#states") return <Demo />;
  return (
    <main className="fixed inset-0 flex flex-col items-center justify-center gap-2">
      <div className="app-drag fixed inset-x-0 top-0 h-titlebar" />
      <h1 className="font-display text-hero font-semibold">Brigadier</h1>
      {daemon && (
        <p className="text-sm text-muted-foreground">
          Daemon connected · pid {daemon.pid} · version {daemon.version}
        </p>
      )}
      {daemon === null && <p className="text-sm text-destructive">Daemon not reachable</p>}
      <a href="#states" className="text-sm text-muted-foreground hover:text-foreground">
        Session states
      </a>
    </main>
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
