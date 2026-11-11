import { useEffect, useState } from "react";

import { EmptyState } from "../components/empty-state";
import { Input } from "../components/input";
import { NavHeader, NavList, NavRow, NavSection } from "../components/nav";
import { matches } from "../shortcuts";
import { SETTINGS_GROUPS, SETTINGS_PAGES, type SettingsPageId, type SettingsSearchResult, searchSettings, settingsPage } from "./pages";

/*
 * Settings, the old app's [D2004, D2022]: while it's open the sidebar shows its nav (a search over every row, then
 * the pages in their groups) and the main area the page. Its route is `#settings/<page>`; Esc goes back.
 */

const PREFIX = "#settings/";
export const settingsPageOf = (hash: string): string | null => (hash.startsWith(PREFIX) ? hash.slice(PREFIX.length) : hash === "#settings" ? "general" : null);

// Where Esc goes back to: the last screen that wasn't Settings.
let back = window.location.hash.startsWith("#settings") ? "" : window.location.hash;
window.addEventListener("hashchange", () => {
  if (!window.location.hash.startsWith("#settings")) back = window.location.hash;
});

/** Opens a page, and brings the row labelled `row` into view once it shows. */
export function openSettings(page: SettingsPageId = "general", row?: string): void {
  window.location.hash = `${PREFIX}${page}`;
  if (row) reveal(row);
}

export function closeSettings(): void {
  window.location.hash = back;
}

/** ⌘, opens Settings (from the keys, or the app menu's Settings…) and ⌘/ its Keyboard shortcuts [D2013, D2022]. Call once. */
export function listenToSettingsKeys(): void {
  addEventListener("keydown", (event) => {
    const page = event.defaultPrevented ? null : matches(event, "settings") ? "general" : matches(event, "shortcuts") ? "shortcuts" : null;
    if (!page) return;
    event.preventDefault();
    openSettings(page);
  });
  window.brigadier?.onMenu((command) => command === "settings" && openSettings("general"));
}

// A row by its label (a kit SettingsRow's label, or a section's `data-setting`), found once its page has drawn it.
const FIND_FRAMES = 60;
let revealing = 0;
function reveal(label: string): void {
  const asked = ++revealing;
  let frames = 0;
  const find = () => {
    if (asked !== revealing) return;
    const target =
      document.querySelector<HTMLElement>(`[data-setting="${CSS.escape(label)}"]`) ??
      [...document.querySelectorAll<HTMLElement>('[data-slot="settings-row"]')].find((row) => row.querySelector(".text-label")?.textContent?.trim() === label);
    if (target) target.scrollIntoView({ block: "center" });
    else if (++frames < FIND_FRAMES) requestAnimationFrame(find);
  };
  requestAnimationFrame(find);
}

const openResult = ({ page, row }: SettingsSearchResult) => openSettings(page.id, row?.label);

/** The sidebar while Settings is open: its title, the search, then the pages; typing lists the rows found. */
export function SettingsNav({ current }: { current: string }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = query.trim() ? searchSettings(query) : null;
  return (
    <>
      <NavHeader title="Settings" />
      <div className="px-2 pb-2">
        <Input
          aria-label="Search settings"
          placeholder="Search"
          value={query}
          className="h-nav-search px-3"
          onValueChange={(value) => {
            setQuery(value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (!results?.length) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((index) => (index + step + results.length) % results.length);
            }
            const chosen = results[active];
            if (event.key === "Enter" && chosen) openResult(chosen);
          }}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pt-1 pb-2">
        {results ? (
          results.length === 0 ? (
            <EmptyState title="No settings match." />
          ) : (
            <NavList>
              {results.map((result, index) => {
                const Icon = result.page.icon;
                return (
                  <li key={`${result.page.id}:${result.row?.label ?? ""}`}>
                    <NavRow data-active={index === active || undefined} className="items-start py-2.5" onMouseEnter={() => setActive(index)} onClick={() => openResult(result)}>
                      <Icon className="mt-0.5 text-muted-foreground" />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{result.row?.label ?? result.page.label}</span>
                        {result.row && (
                          <span className="truncate text-xs text-muted-foreground">
                            {result.page.label}
                            {result.row.section ? ` › ${result.row.section}` : ""}
                          </span>
                        )}
                      </span>
                    </NavRow>
                  </li>
                );
              })}
            </NavList>
          )
        ) : (
          SETTINGS_GROUPS.map((group) => (
            <NavSection key={group} title={group === "end" ? undefined : group}>
              <NavList>
                {SETTINGS_PAGES.filter((page) => page.group === group).map((page) => {
                  const Icon = page.icon;
                  return (
                    <li key={page.id}>
                      <NavRow aria-current={page.id === current ? "page" : undefined} onClick={() => openSettings(page.id)}>
                        <Icon className="text-muted-foreground" />
                        <span className="truncate">{page.label}</span>
                      </NavRow>
                    </li>
                  );
                })}
              </NavList>
            </NavSection>
          ))
        )}
      </div>
    </>
  );
}

// Something open over or in the page that Esc belongs to first.
const ESC_OWNERS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** The main area while Settings is open: the page. Esc goes back to what was shown. */
export function SettingsView({ page }: { page: string }) {
  const Page = settingsPage(page).component;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest(ESC_OWNERS)) return;
      if (document.querySelector(ESC_OWNERS)) return;
      closeSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  // Under the titlebar, the page on the content's own surface, where a session's tabs would be.
  return (
    <>
      <div className="app-drag h-titlebar shrink-0" />
      <main className="flex min-h-0 flex-1 overflow-clip rounded-e-surface bg-background">
        <Page key={page} />
      </main>
    </>
  );
}
