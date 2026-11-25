// Mockup only: Settings › Storage, the picked look, on fake data in Settings' nav; &state=counting holds the count part
// way, &state=freed shows nothing left to free. ?v=real is the app itself on a fake daemon (storage-real.ts).
import "../src/theme.css";
import "./fixtures.css";
// Settings' pages first, as the app loads them: General and the pages list import each other.
import { SETTINGS_GROUPS, SETTINGS_PAGES } from "../src/settings/pages";

import { createRoot } from "react-dom/client";

import { NavList, NavRow, NavSection } from "../src/components/nav";
import { Toaster } from "../src/components/toast";
import { TooltipProvider } from "../src/components/tooltip";
import { StorageView } from "../src/settings/storage";
import { useStorage } from "./storage-data";
import { openReal } from "./storage-real";

function Page() {
  return <StorageView storage={useStorage()} />;
}

function Nav() {
  return (
    <nav aria-label="Settings" className="mockup-nav w-60 shrink-0 flex-col gap-4 overflow-y-auto px-2 pt-tab-bar">
      {SETTINGS_GROUPS.map((group) => {
        const pages = SETTINGS_PAGES.filter((page) => page.group === group);
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

if (new URLSearchParams(location.search).get("v") === "real") void openReal();
else createRoot(document.getElementById("root")!).render(
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
