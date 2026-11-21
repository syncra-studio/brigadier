import { useEffect, useRef, useState } from "react";

import { EmptyState } from "../components/empty-state";
import { StateDot } from "../components/state-dot";
import { NavHeader, NavList, NavRow, NavSection } from "../components/nav";
import { ArrowLeft, MagnifyingGlassSearch, XCircleFilled } from "../icons";
import { HomeMark } from "../sidebar/strip";
import { matches } from "../shortcuts";
import { useRoutingDot } from "./routing";
import { SETTINGS_GROUPS, SETTINGS_PAGES, type SettingsPageId, type SettingsSearchResult, searchSettings, settingsPage } from "./pages";

/*
 * Settings, the old app's [D2004, D2022]: while it's open the sidebar shows its nav (a search over every row, then
 * the pages in their groups) and the main area the page. Its route is `#settings/<page>`, `#settings/providers/<agent>` for
 * an agent's page; Esc goes back.
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

/** Where leaving Settings goes: the last screen that wasn't Settings. */
export const settingsOrigin = (): string => back;

/** ⌘, opens Settings (from the keys, or the app menu's Settings…) and ⌘/ its Keyboard shortcuts [D2013, D2022]. Call once. */
export function listenToSettingsKeys(): void {
  addEventListener("keydown", (event) => {
    const page = event.defaultPrevented ? null : matches(event, "settings") ? "general" : matches(event, "shortcuts") ? "shortcuts" : null;
    if (!page) return;
    event.preventDefault();
    // ⌘, leaves Settings when it's open, as the old app's toggleSettings did.
    if (page === "general" && settingsPageOf(window.location.hash) !== null) closeSettings();
    else openSettings(page);
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
  const field = useRef<HTMLInputElement>(null);
  const results = query.trim() ? searchSettings(query) : null;
  const offered = useRoutingDot();
  const search = (value: string) => {
    setQuery(value);
    setActive(0);
  };
  return (
    <>
      {/* Its title on the app sidebar's name line, and its rows on the sessions' insets, so a swap moves nothing [D48 D227]. */}
      <NavHeader start={<HomeMark />} title="Settings" />
      <div className="ps-2 pe-2.5 pb-2">
        <label data-slot="settings-search" className="flex h-nav-search min-w-0 items-center gap-2 rounded-capsule border border-fill-active bg-fill px-3 has-focus-visible:focus-ring">
          <MagnifyingGlassSearch aria-hidden className="size-icon-md shrink-0 text-quiet-foreground" />
          <input
            ref={field}
            aria-label="Search settings"
            placeholder="Search"
            value={query}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 cursor-text bg-transparent text-sm outline-none placeholder:text-faint-foreground"
            onChange={(event) => search(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.stopPropagation();
                search("");
                return;
              }
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
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              className="flex shrink-0 cursor-pointer items-center rounded-capsule text-faint-foreground hover:text-foreground focus-visible:focus-ring"
              onClick={() => {
                search("");
                requestAnimationFrame(() => field.current?.focus());
              }}
            >
              <XCircleFilled className="size-icon-sm" />
            </button>
          )}
        </label>
      </div>
      {/* The scrollbar keeps its room, as the sessions' list's. */}
      <div className="scroll-edge-fade edge-fade-settings-nav scroll-gutter flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto ps-2 pt-1 pb-2">
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
                      <Icon className="mt-0.5 text-quiet-foreground" />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{result.row?.label ?? result.page.label}</span>
                        {result.row && (
                          <span className="truncate text-xs text-faint-foreground">
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
                      <NavRow aria-current={page.id === settingsPage(current).id ? "page" : undefined} onClick={() => openSettings(page.id)}>
                        <Icon className="text-quiet-foreground" />
                        <span className="truncate">{page.label}</span>
                        {page.id === "routing" && offered && (
                          <span className="ms-auto flex pe-1">
                            <StateDot tone="unread" label="Brigadier offers a change" />
                          </span>
                        )}
                      </NavRow>
                    </li>
                  );
                })}
              </NavList>
            </NavSection>
          ))
        )}
      </div>
      {/* Back to the app, at the foot where the app's sidebar keeps Settings, leaving the title on the name line [D48]. */}
      <div className="shrink-0 ps-2 pe-2.5 pb-2">
        <NavRow onClick={closeSettings}>
          <ArrowLeft className="text-quiet-foreground" />
          <span className="truncate">Back to app</span>
        </NavRow>
      </div>
    </>
  );
}

// Something open over or in the page that Esc belongs to first.
const ESC_OWNERS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** The main area while Settings is open: the page. Esc goes back to what was shown. */
export function SettingsView({ page }: { page: string }) {
  const Page = settingsPage(page).component;
  const detail = page.split("/").slice(1).map(decodeURIComponent).join("/") || undefined;
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
  // The page beside the nav, on the main area's colour.
  return (
    <main className="flex min-h-0 flex-1 overflow-x-clip">
      <Page key={page} detail={detail} />
    </main>
  );
}
