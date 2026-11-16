import { type RefObject, useEffect, useState } from "react";

import { cx } from "../components/cx";
import { Popover, PopoverContent } from "../components/popover";
import { Globe, Search, X } from "../icons";
import { run } from "../onboarding/api";
import { useTabs } from "../shell/tab-store";
import { browserAddress, webAddress } from "./address";
import { useBrowserPages } from "./pages";

/**
 * What the Browser tab's address field suggests while it is typed in: going to the address or
 * searching the web for the words first, then the session's other Browser tabs that match (to
 * switch to), then the pages of the history that match.
 */
export type Suggestion =
  | { kind: "go"; url: string; search: boolean; text: string }
  | { kind: "tab"; id: string; url: string; title: string }
  | { kind: "visit"; id: number; url: string; title: string };

/** A page of the history, as Rust's `browser history` gives it. */
export type Visit = { id: number; url: string; title: string; atMs: number };

/** A Browser tab of the session, as the address field may switch to it. */
type OpenTab = { id: string; url: string; title: string };

/** At most so many open tabs, and suggestions in all. */
const TABS = 3;
const ALL = 8;

const web = (url: string) => /^https?:\/\//i.test(url);

/**
 * The suggestions for `typed`, from the session's Browser tabs `tabs` (the one typed in,
 * `self`, left out) and history `visits` (newest first): none for nothing typed.
 */
function addressSuggestions(typed: string, tabs: readonly OpenTab[], visits: readonly Visit[], self: string): Suggestion[] {
  const text = typed.trim();
  const to = browserAddress(text);
  if (!to) return [];
  const words = text.toLowerCase();
  const matches = (url: string, title: string) => url.toLowerCase().includes(words) || title.toLowerCase().includes(words);
  const found: Suggestion[] = [{ kind: "go", url: to, search: webAddress(text) === null, text }];
  const shown = new Set<string>([to]);
  let switches = 0;
  for (const tab of tabs) {
    if (switches === TABS) break;
    if (tab.id === self || !web(tab.url) || !matches(tab.url, tab.title)) continue;
    switches++;
    found.push({ kind: "tab", id: tab.id, url: tab.url, title: tab.title });
    shown.add(tab.url);
  }
  for (const visit of visits) {
    if (found.length >= ALL) break;
    if (!web(visit.url) || shown.has(visit.url) || !matches(visit.url, visit.title)) continue;
    found.push({ kind: "visit", id: visit.id, url: visit.url, title: visit.title });
    shown.add(visit.url);
  }
  return found;
}

/** The row `step` (1 down, -1 up) from row `at` of `count`; -1 is the field itself. */
export function stepSuggestion(at: number, step: 1 | -1, count: number): number {
  if (count === 0) return -1;
  const next = at + step;
  if (next >= count) return -1;
  if (next < -1) return count - 1;
  return next;
}

/** What the address field of tab `self` in `owner`'s tabs suggests for `typed` (null: not typing): see `addressSuggestions`. */
export function useAddressSuggestions(owner: string, self: string, typed: string | null) {
  const { tabs: all } = useTabs(owner);
  const pages = useBrowserPages();
  const tabs = all.flatMap((tab) => (tab.kind === "browser" ? [{ id: tab.id, url: pages.get(tab.id)?.url || tab.target || "", title: pages.get(tab.id)?.title ?? "" }] : []));
  const [visits, setVisits] = useState<Visit[]>([]);
  const [changed, setChanged] = useState(0);
  const query = typed?.trim() ?? "";
  useEffect(() => {
    if (!query) return;
    let current = true;
    const timer = setTimeout(() => {
      run(["browser", owner, "history", "search", query, "--limit", "24"]).then(
        (reply) => current && setVisits(reply.history as Visit[]),
        () => current && setVisits([]),
      );
    }, 80);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // `changed` reads the history again after a removal.
  }, [owner, query, changed]);
  const rows = addressSuggestions(query, tabs, query ? visits : [], self);
  const remove = (id: number) => {
    setVisits((shown) => shown.filter((visit) => visit.id !== id));
    const again = () => setChanged((count) => count + 1);
    run(["browser", owner, "history", "remove", String(id)]).then(again, again);
  };
  return { rows, remove };
}

/** The pages of `owner`'s history, newest first, read again with `again`. */
export function useHistory(owner: string, again: unknown): Visit[] {
  const [visits, setVisits] = useState<Visit[]>([]);
  useEffect(() => {
    let current = true;
    run(["browser", owner, "history", "list"]).then(
      (reply) => current && setVisits(reply.history as Visit[]),
      () => current && setVisits([]),
    );
    return () => {
      current = false;
    };
  }, [owner, again]);
  return visits;
}

/** The favicon an open page of `origin` has, if one does (the old SiteIcon's). */
export function useOriginFavicon(origin: string): string | null {
  for (const page of useBrowserPages().values()) {
    try {
      if (page.favicon && new URL(page.url).origin === origin) return page.favicon;
    } catch {
      // Not a page with an origin.
    }
  }
  return null;
}

const label = (row: Suggestion) => (row.kind === "go" ? (row.search ? `Search the web for “${row.text}”` : row.url) : row.title || row.url);

/**
 * The address field's suggestions, under the field while it is typed in. The keyboard stays in
 * the field: ↑ and ↓ pick a row, Enter takes it, a click takes one, and × removes a page from
 * the history.
 */
export function AddressSuggestions({
  anchor,
  field,
  rows,
  open,
  highlight,
  onPick,
  onHighlight,
  onRemove,
  onClose,
}: {
  anchor: RefObject<HTMLDivElement | null>;
  field: RefObject<HTMLInputElement | null>;
  rows: Suggestion[];
  open: boolean;
  highlight: number;
  onPick: (row: Suggestion) => void;
  onHighlight: (index: number) => void;
  onRemove: (id: number) => void;
  onClose: () => void;
}) {
  return (
    <Popover
      open={open && rows.length > 0}
      onOpenChange={(next, { reason, event }) => {
        // A click in the field types on.
        if (!next && !(reason === "outside-press" && event.target instanceof Node && anchor.current?.contains(event.target))) onClose();
      }}
    >
      <PopoverContent anchor={anchor} align="start" data-slot="browser-suggestions" initialFocus={false} finalFocus={false} className="w-anchor">
        <div id="browser-suggestions" role="listbox" aria-label="Suggestions">
          {rows.map((row, index) => {
            const Icon = row.kind === "go" && row.search ? Search : Globe;
            return (
              <div
                key={row.kind === "visit" ? `visit-${row.id}` : row.kind === "tab" ? `tab-${row.id}` : "go"}
                id={`browser-suggestion-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={index === highlight}
                data-kind={row.kind}
                // The keyboard stays in the field.
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => index !== highlight && onHighlight(index)}
                onClick={() => onPick(row)}
                onKeyDown={(event) => event.key === "Enter" && onPick(row)}
                className={cx("group/suggestion flex h-browser-menu-item cursor-default items-center gap-2 rounded-capsule ps-2 pe-1 text-label", index === highlight && "bg-fill")}
              >
                <Icon aria-hidden className="size-icon-md shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  {label(row)}
                  {row.kind !== "go" && row.title && <span className="text-muted-foreground"> · {row.url.replace(/^https?:\/\/(www\.)?/, "")}</span>}
                </span>
                {row.kind === "tab" && <span className="shrink-0 text-xs text-muted-foreground">Switch to tab</span>}
                {row.kind === "visit" && (
                  <button
                    type="button"
                    aria-label={`Remove ${row.title || row.url} from history`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemove(row.id);
                      field.current?.focus();
                    }}
                    className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 group-hover/suggestion:opacity-100 group-aria-selected/suggestion:opacity-100 hover:bg-fill focus-visible:opacity-100"
                  >
                    <X className="size-icon-sm" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
