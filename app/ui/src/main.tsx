import { createRoot } from "react-dom/client";

import { useDaemon } from "./daemon";
import "./theme.css";

function App() {
  const daemon = useDaemon();
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
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
