// Files and Search as the panel mounts them (panel/views.tsx, one per owner), fed by fake data until step 2.17 wires
// them to Rust. Opening a file waits for the file tab kind [D1032].
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FILES, findFiles, IGNORED, MARKS, replaceFake, searchFake } from "./fake";
import { detailsShown, EMPTY_FORM, SearchPanel, searchQuery, type SearchForm } from "./search";
import { FileTree, type OnOpen } from "./tree";
import type { FolderEntry, SearchQuery, SearchResults } from "./types";

/** How long typing pauses before the search runs (the old 250 ms). */
const TYPING_MS = 250;

export function FilesView({ owner, shown = null, onOpen = () => {} }: { owner: string; shown?: string | null; onOpen?: OnOpen }) {
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState<Record<string, FolderEntry[]>>({});
  const readIgnored = useCallback(
    (paths: string[]) => setLoaded((last) => ({ ...last, ...Object.fromEntries(paths.map((path) => [path, IGNORED[path] ?? []])) })),
    [],
  );
  const results = useMemo(() => (query ? findFiles(FILES, query) : null), [query]);
  return (
    <FileTree
      scope={owner}
      listing={{ state: "listed", list: FILES }}
      marks={MARKS}
      loaded={loaded}
      onReadIgnored={readIgnored}
      shown={shown}
      results={results}
      onQuery={setQuery}
      onOpen={onOpen}
    />
  );
}

export function SearchView({ owner: _owner, onOpen = () => {} }: { owner: string; onOpen?: (path: string, line: number, keep: boolean) => void }) {
  const [form, setForm] = useState<SearchForm>(() => ({ ...EMPTY_FORM, details: detailsShown }));
  const [results, setResults] = useState<SearchResults | null>(null);
  const dismissed = useRef<ReadonlySet<string>>(new Set());
  const [asked, setAsked] = useState(0);
  // Keyed on what the query asks, as in the old app: typing in Replace doesn't search again.
  const query = searchQuery(form);
  const key = query ? JSON.stringify(query) : "";
  useEffect(() => {
    if (!key) return setResults(null);
    const next = JSON.parse(key) as SearchQuery;
    // Searching… while typing pauses, then what the fake checkout holds.
    setResults((last) => (last ? { ...last, done: null } : { query: next, files: [], done: null, error: null, filteredFiles: 0 }));
    const timer = setTimeout(() => setResults(searchFake(next, dismissed.current)), TYPING_MS);
    return () => clearTimeout(timer);
  }, [key, asked]);
  return (
    <SearchPanel
      form={form}
      onForm={(change) => setForm((last) => ({ ...last, ...change }))}
      results={results}
      onSearch={() => {
        dismissed.current = new Set();
        setAsked((count) => count + 1);
      }}
      // The old app found again after a replace changed the checkout.
      onReplace={(file) =>
        results
          ? replaceFake(results, form.replace, file).then((outcome) => {
              setAsked((count) => count + 1);
              return outcome;
            })
          : Promise.reject(new Error("Nothing to replace"))
      }
      // Gone from the results at once, as in the old app; searches until Enter leave it out.
      onDismiss={(path) => {
        dismissed.current = new Set([...dismissed.current, path]);
        setResults((last) => last && { ...last, files: last.files.filter((file) => file.path !== path), filteredFiles: last.filteredFiles + 1 });
      }}
      onOpen={onOpen}
    />
  );
}
