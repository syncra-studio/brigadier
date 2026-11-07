// Dev-only: every kit component in every state (D2). Opened by `pnpm gallery`.
import { Kit } from "./kit";
import "./gallery.css";

export default function Gallery() {
  return (
    <div className="fixed inset-0 overflow-y-auto">
      <header className="app-drag sticky top-0 z-10 flex h-titlebar items-center border-b border-divider bg-background ps-traffic-lights">
        <h1 className="ps-2 text-sm font-medium">Components</h1>
      </header>
      <main className="isolate flex flex-col gap-10 px-8 py-8">
        <Kit />
      </main>
    </div>
  );
}
