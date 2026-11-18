import type { RefObject } from "react";

import { cx } from "../components/cx";
import { Popover, PopoverContent } from "../components/popover";
import { Globe, Search } from "../icons";
import { useTabs } from "../shell/tab-store";
import { browserAddress, webAddress } from "./address";
import { useBrowserPages } from "./pages";

/**
 * What the Browser tab's address field suggests while it is typed in: going to the address or
 * searching the web for the words first, then the session's other Browser tabs that match (to
 * switch to).
 */
export type Suggestion =
  | { kind: "go"; url: string; search: boolean; text: string }
  | { kind: "tab"; id: string; url: string; title: string };

/** A Browser tab of the session, as the address field may switch to it. */
type OpenTab = { id: string; url: string; title: string };

/** At most so many open tabs. */
const TABS = 3;

const web = (url: string) => /^https?:\/\//i.test(url);

/**
 * The suggestions for `typed`, from the session's Browser tabs `tabs` (the one typed in,
 * `self`, left out): none for nothing typed.
 */
function addressSuggestions(typed: string, tabs: readonly OpenTab[], self: string): Suggestion[] {
  const text = typed.trim();
  const to = browserAddress(text);
  if (!to) return [];
  const words = text.toLowerCase();
  const matches = (url: string, title: string) => url.toLowerCase().includes(words) || title.toLowerCase().includes(words);
  const found: Suggestion[] = [{ kind: "go", url: to, search: webAddress(text) === null, text }];
  for (const tab of tabs) {
    if (found.length > TABS) break;
    if (tab.id === self || !web(tab.url) || !matches(tab.url, tab.title)) continue;
    found.push({ kind: "tab", id: tab.id, url: tab.url, title: tab.title });
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
  return addressSuggestions(typed?.trim() ?? "", tabs, self);
}

const label = (row: Suggestion) => (row.kind === "go" ? (row.search ? `Search the web for “${row.text}”` : row.url) : row.title || row.url);

/**
 * The address field's suggestions, under the field while it is typed in. The keyboard stays in
 * the field: ↑ and ↓ pick a row, Enter takes it, and a click takes one.
 */
export function AddressSuggestions({
  anchor,
  rows,
  open,
  highlight,
  onPick,
  onHighlight,
  onClose,
}: {
  anchor: RefObject<HTMLDivElement | null>;
  rows: Suggestion[];
  open: boolean;
  highlight: number;
  onPick: (row: Suggestion) => void;
  onHighlight: (index: number) => void;
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
                key={row.kind === "tab" ? `tab-${row.id}` : "go"}
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
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
