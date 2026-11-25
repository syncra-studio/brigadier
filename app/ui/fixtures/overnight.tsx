// Mockup only: Overnight mode, from turning it on to the morning. ?v=a, b or c is a variant, its moments down the page,
// each live on fake data. Not the app.
import "../src/theme.css";
import "./fixtures.css";
import "./overnight.css";
import "../src/thread/markdown.css";

import { createRoot } from "react-dom/client";

import { Toaster } from "../src/components/toast";
import { TooltipProvider } from "../src/components/tooltip";
import { VariantA } from "./overnight-a";
import { VariantB } from "./overnight-b";
import { VariantC } from "./overnight-c";

const Variant = { a: VariantA, b: VariantB, c: VariantC }[new URLSearchParams(location.search).get("v") ?? "a"] ?? VariantA;
// The gallery's page scrolls itself; the app's body doesn't.
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <main className="flex h-screen flex-col gap-10 overflow-y-auto px-4 py-6">
      <Variant />
    </main>
    <Toaster />
  </TooltipProvider>,
);
