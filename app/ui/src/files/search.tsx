import { type KeyboardEvent, type ReactNode, useCallback, useMemo, useState } from "react";

import { Button } from "../components/button";
import { ConfirmDialog } from "../components/confirm-dialog";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { Input } from "../components/input";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/menu";
import { SettingsSlider } from "../icons";
import { PLAIN_FIELD } from "./field";
import { Clear, Collapse } from "./icons";
import { ResultList, type OnOpenLine } from "./search-results";
import { baseName } from "./tree";
import type { ReplaceOutcome, ReplaceSkip, SearchQuery, SearchResults } from "./types";

/**
 * The panel's Search (⇧⌘F), ported from the old SearchPanel [D48, D1003] and drawn as direction C's "Kit · menu"
 * [D1099, D1106]: text or a pattern across the checkout, with match case, whole word and regular expression and files
 * to include and exclude in one options menu, and Replace all. Results come
 * grouped by file; a line opens the file there. The search itself and Replace all run in Rust (step 2.17): this
 * view only asks, through `onSearch` and `onReplace`.
 */

/** What the fields hold. */
export type SearchForm = Omit<SearchQuery, "text"> & { text: string; replace: string; /** Files to include and exclude shown. */ details: boolean };

export const EMPTY_FORM: SearchForm = { text: "", replace: "", include: "", exclude: "", matchCase: false, wholeWord: false, regex: false, details: false };

/** The query the fields ask for, or null with nothing to find. Hidden include and exclude don't count, as in the old app. */
export function searchQuery({ replace: _replace, details, ...query }: SearchForm): SearchQuery | null {
  return query.text ? { ...query, include: details ? query.include : "", exclude: details ? query.exclude : "" } : null;
}

const sameQuery = (a: SearchQuery, b: SearchQuery | null) => !!b && (Object.keys(a) as (keyof SearchQuery)[]).every((key) => a[key] === b[key]);

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

// shortcut: whether include and exclude show is kept in memory for the app's run; step 2.15 keeps it in Rust.
export let detailsShown = false;

/** The options menu's switches, in the old order. */
const OPTIONS = [
  ["matchCase", "Match case"],
  ["wholeWord", "Whole word"],
  ["regex", "Regular expression"],
] as const;

export function SearchPanel({
  form,
  onForm,
  results,
  onSearch,
  onReplace,
  onDismiss,
  onOpen,
  readOnly = false,
  defaultOutcome = null,
}: {
  form: SearchForm;
  onForm: (change: Partial<SearchForm>) => void;
  /** What the last search found; null before one. */
  results: SearchResults | null;
  /** Searches again now (Enter, Refresh); typing searches by itself once it pauses. */
  onSearch: () => void;
  /** Replaces what the finished search found, in every file or in `file`, with what the Replace field holds. */
  onReplace: (file?: string) => Promise<ReplaceOutcome>;
  onDismiss: (path: string) => void;
  onOpen: OnOpenLine;
  /** Replace left out. */
  readOnly?: boolean;
  /** What a Replace all did, shown at once (the gallery's frozen states). */
  defaultOutcome?: ReplaceOutcome | { error: string } | null;
}) {
  const query = useMemo(() => searchQuery(form), [form]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback(
    (path: string) =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (!next.delete(path)) next.add(path);
        return next;
      }),
    [],
  );
  const [confirming, setConfirming] = useState<{ file?: string } | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [outcome, setOutcome] = useState<ReplaceOutcome | { error: string } | null>(defaultOutcome);
  const matches = results?.files.reduce((sum, file) => sum + file.matches, 0) ?? 0;
  const searching = !!results && !results.done && !results.error;
  // Only what a finished search found, for the query the fields hold.
  const canReplace = !readOnly && !!results?.done && results.files.length > 0 && !replacing && sameQuery(results.query, query);
  const replace = (file?: string) => {
    if (!canReplace) return;
    setReplacing(true);
    onReplace(file)
      .then(setOutcome)
      .catch((error: unknown) => setOutcome({ error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        setReplacing(false);
        setConfirming(null);
      });
  };
  const set = (change: Partial<SearchForm>) => {
    onForm(change);
    if ("text" in change) setOutcome(null);
  };
  const allCollapsed = !!results?.files.length && results.files.every((file) => collapsed.has(file.path));
  const empty = !form.text && !form.replace && !form.include && !form.exclude;
  const confirmedFiles = results?.files.filter((file) => !confirming?.file || file.path === confirming.file) ?? [];
  const confirmedMatches = confirmedFiles.reduce((sum, file) => sum + file.matches, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-control-md shrink-0 items-center gap-0.5 ps-3 pe-2">
        <h2 className="min-w-0 flex-1 text-sm font-medium">Search</h2>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            render={<TooltipIconButton tooltip="Search options" size="icon-sm" dot={form.matchCase || form.wholeWord || form.regex || form.details ? "bg-link" : undefined} />}
          >
            <SettingsSlider />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {OPTIONS.map(([key, label]) => (
              <DropdownMenuCheckboxItem key={key} checked={form[key]} onCheckedChange={(on) => set({ [key]: on })}>
                {label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={form.details}
              onCheckedChange={(details) => {
                detailsShown = details;
                set({ details });
              }}
            >
              Files to include and exclude
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <TooltipIconButton
          tooltip="Clear"
          size="icon-sm"
          disabled={empty}
          onClick={() => {
            set({ text: "", replace: "", include: "", exclude: "" });
            setOutcome(null);
          }}
        >
          <Clear />
        </TooltipIconButton>
        <TooltipIconButton
          tooltip={allCollapsed ? "Expand all" : "Collapse all"}
          size="icon-sm"
          disabled={!results?.files.length}
          onClick={() => setCollapsed(new Set(allCollapsed ? [] : results?.files.map((file) => file.path)))}
        >
          <Collapse />
        </TooltipIconButton>
      </header>
      <div className="flex shrink-0 flex-col gap-2 border-b border-divider px-3 pb-3">
        <Input aria-label="Search" placeholder="Search" {...PLAIN_FIELD} value={form.text} onChange={(event) => set({ text: event.target.value })} onKeyDown={onEnter(() => query && onSearch())} />
        {!readOnly && (
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <Input
                aria-label="Replace"
                placeholder="Replace"
                {...PLAIN_FIELD}
                value={form.replace}
                onChange={(event) => set({ replace: event.target.value })}
                onKeyDown={onEnter(() => canReplace && setConfirming({}))}
              />
            </div>
            <Button variant="soft" size="sm" disabled={!canReplace} onClick={() => setConfirming({})}>
              Replace all
            </Button>
          </div>
        )}
        {form.details && (
          <>
            <Input aria-label="Files to include" placeholder="Files to include, e.g. src/**, *.ts" {...PLAIN_FIELD} value={form.include} onChange={(event) => set({ include: event.target.value })} />
            <Input aria-label="Files to exclude" placeholder="Files to exclude, e.g. *.test.ts" {...PLAIN_FIELD} value={form.exclude} onChange={(event) => set({ exclude: event.target.value })} />
          </>
        )}
      </div>
      {results?.error ? (
        <ErrorLine size="sm" error={results.error} className="p-2" />
      ) : (
        results && (
          <>
            <div className="flex shrink-0 flex-col px-3 pt-1" aria-busy={searching}>
              <p data-slot="search-summary" className="flex h-control-sm items-center px-1 text-xs text-muted-foreground">
                <span className="min-w-0 truncate">
                  {results.files.length === 0
                    ? !results.done
                      ? "Searching…"
                      : results.filteredFiles
                        ? "All results dismissed. Press Enter in Search to show them again."
                        : "No results"
                    : `${plural(matches, "result")} in ${plural(results.files.length, "file")}${searching ? "…" : ""}`}
                </span>
              </p>
              {outcome && <ReplaceNote outcome={outcome} />}
              {results.done?.capped && <p className="px-1 pb-1 text-xs text-muted-foreground">Only the first results are shown. Narrow the search to see the rest.</p>}
            </div>
            <ResultList
              files={results.files}
              collapsed={collapsed}
              onToggle={toggle}
              onOpen={onOpen}
              onDismiss={onDismiss}
              onReplace={canReplace ? (path) => setConfirming({ file: path }) : null}
            />
          </>
        )
      )}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={results ? replaceTitle(confirmedMatches, confirmedFiles.length) : null}
        description={replaceDescription(form.replace)}
        confirm="Replace"
        busy={replacing}
        disabled={!canReplace || confirmedFiles.length === 0}
        onConfirm={() => replace(confirming?.file)}
      />
    </div>
  );
}

/** Replace all's confirm, in the old words. */
export const replaceTitle = (matches: number, files: number) => `Replace ${plural(matches, "match", "matches")} in ${plural(files, "file")}?`;
export const replaceDescription = (replace: string): ReactNode => (
  <>
    {replace ? <>Each becomes “{replace}”.</> : "Each is deleted."} If a file changed since the search, none is replaced.
  </>
);

/** Enter (not while composing) runs `run`. */
const onEnter = (run: () => void) => (event: KeyboardEvent<HTMLInputElement>) => {
  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
    event.preventDefault();
    run();
  }
};

const skipList = (skips: ReplaceSkip[]) => skips.map((skip) => `${baseName(skip.path)} (${skip.reason})`).join(", ");

function ReplaceNote({ outcome }: { outcome: ReplaceOutcome | { error: string } }) {
  if ("error" in outcome) return <ErrorLine error={outcome.error} className="px-1 pb-1" />;
  return (
    <div role="status" className="px-1 pb-1 text-xs text-muted-foreground">
      {outcome.skipped.length > 0 ? (
        <p className="text-warning">Nothing was replaced: {skipList(outcome.skipped)}. Search again, then replace.</p>
      ) : (
        <p>
          Replaced {plural(outcome.matches, "match", "matches")} in {plural(outcome.files, "file")}.
        </p>
      )}
      {outcome.unrestored.length > 0 && <ErrorLine error={`Couldn’t put back: ${skipList(outcome.unrestored)}`} />}
    </div>
  );
}
