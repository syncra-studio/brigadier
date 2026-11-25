// Mockup only: Settings › Storage on fake data, in Settings' nav where it would sit. ?v=a, b or c is the variant;
// &state=counting holds the count part way, &state=freed shows nothing left to free. Not the app.
import "../src/theme.css";
import "./fixtures.css";
// Settings' pages first, as the app loads them: General and the pages list import each other.
import { SETTINGS_GROUPS, SETTINGS_PAGES } from "../src/settings/pages";

import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";

import { NavList, NavRow, NavSection } from "../src/components/nav";
import { Toaster } from "../src/components/toast";
import { TooltipProvider } from "../src/components/tooltip";
import type { IconProps } from "../src/icons";
import { VariantA } from "./storage-a";
import { VariantB } from "./storage-b";
import { VariantC } from "./storage-c";

const VARIANTS: Record<string, ComponentType> = { a: VariantA, b: VariantB, c: VariantC };
const Page = VARIANTS[new URLSearchParams(location.search).get("v") ?? "a"] ?? VariantA;

/** A drive, for the nav's row. */
function Drive({ className }: IconProps) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.33" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M5.2 4.2h9.6l2.5 7v3.1c0 .9-.7 1.5-1.5 1.5H4.2c-.8 0-1.5-.6-1.5-1.5v-3.1zM2.7 11.2h14.6M6 13.5h.01M8.5 13.5h.01" />
    </svg>
  );
}

function Nav() {
  return (
    <nav aria-label="Settings" className="mockup-nav w-60 shrink-0 flex-col gap-4 overflow-y-auto px-2 pt-tab-bar">
      {SETTINGS_GROUPS.map((group) => {
        const pages = SETTINGS_PAGES.filter((page) => page.group === group).map(({ id, label, icon }) => ({ id: id as string, label, icon }));
        if (group === "Browser & Data") pages.push({ id: "storage", label: "Storage", icon: Drive });
        return (
          <NavSection key={group} title={group === "end" ? undefined : group}>
            <NavList>
              {pages.map(({ id, label, icon: Icon }) => (
                <li key={id}>
                  <NavRow aria-current={id === "storage" ? "page" : undefined}>
                    <Icon className="text-quiet-foreground" />
                    <span className="truncate">{label}</span>
                  </NavRow>
                </li>
              ))}
            </NavList>
          </NavSection>
        );
      })}
    </nav>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <div className="flex h-full">
      <Nav />
      <main className="flex min-w-0 flex-1 overflow-x-clip pt-tab-bar">
        <Page />
      </main>
    </div>
    <Toaster />
  </TooltipProvider>,
);
