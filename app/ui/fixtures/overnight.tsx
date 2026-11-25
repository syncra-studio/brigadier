// Mockup only: Overnight mode, from turning it on to the morning. A, the picked look, its moments down the page, each
// live on fake data; ?v=real is the app itself on a fake daemon (overnight-real.ts).
import "../src/theme.css";
import "./fixtures.css";
import "../src/thread/markdown.css";

import { createRoot } from "react-dom/client";

import { Toaster } from "../src/components/toast";
import { TooltipProvider } from "../src/components/tooltip";
import { VariantA } from "./overnight-a";
import { openReal } from "./overnight-real";

if (new URLSearchParams(location.search).get("v") === "real") void openReal();
else
  // The gallery's page scrolls itself; the app's body doesn't.
  createRoot(document.getElementById("root")!).render(
    <TooltipProvider>
      <main className="flex h-screen flex-col gap-10 overflow-y-auto px-4 py-6">
        <VariantA />
      </main>
      <Toaster />
    </TooltipProvider>,
  );
