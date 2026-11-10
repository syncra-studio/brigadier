// Files and Search as the panel mounts them (panel/views.tsx, one per owner), fed by fake data until step 2.17 wires
// them to Rust. Opening a file waits for the file tab kind [D1032].
import { useCallback, useEffect, useMemo, useState } from "react";

import { FILES, findFiles, IGNORED, MARKS, replaceFake, searchFake } from "./fake";
import { EMPTY_FORM, SearchPanel, searchQuery, type SearchForm } from "./search";
import { FileTree, type OnOpen } from "./tree";
import type { FolderEntry, SearchResults } from "./types";

/** How long typing pauses before the search runs (the old 250 ms). */
const TYPING_MS = 250;

export function FilesView({ owner, onOpen = () => {} }: { owner: string; onOpen?: OnOpen }) {
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
      results={results}
      onQuery={setQuery}
      onOpen={onOpen}
    />
  );
}

export function SearchView({ owner: _owner, onOpen = () => {} }: { owner: string; onOpen?: (path: string, line: number, keep: boolean) => void }) {
  const [form, setForm] = useState<SearchForm>(EMPTY_FORM);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [asked, setAsked] = useState(0);
  const query = useMemo(() => searchQuery(form), [form]);
  useEffect(() => {
    if (!query) return setResults(null);
    // Searching… while typing pauses, then what the fake checkout holds.
    setResults((last) => (last ? { ...last, done: null } : { query, files: [], done: null, error: null, filteredFiles: 0 }));
    const timer = setTimeout(() => setResults(searchFake(query, dismissed)), TYPING_MS);
    return () => clearTimeout(timer);
  }, [query, dismissed, asked]);
  return (
    <SearchPanel
      form={form}
      onForm={(change) => setForm((last) => ({ ...last, ...change }))}
      results={results}
      onSearch={() => {
        setDismissed(new Set());
        setAsked((count) => count + 1);
      }}
      onReplace={(file) => (results ? replaceFake(results, file) : Promise.reject(new Error("Nothing to replace")))}
      onDismiss={(path) => setDismissed((last) => new Set([...last, path]))}
      onOpen={onOpen}
    />
  );
}
