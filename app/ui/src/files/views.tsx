// Files and Search as the panel mounts them (panel/views.tsx), on the on-screen checkout's Rust reads [D1002, D1003]:
// the tree's listing, marks and filename search, an ignored folder's contents, and Search's stream and Replace all.
import { useCallback, useEffect, useRef, useState } from "react";

import { ask, setFoundHandler, useDaemon } from "../daemon";
import { sourceArgs, useGit } from "../panel/git";
import { detailsShown, EMPTY_FORM, SearchPanel, searchQuery, type SearchForm } from "./search";
import { FileTree, type OnOpen } from "./tree";
import type { ChangeMarks, FolderEntry, Listing, ReplaceOutcome, SearchFile, SearchQuery, SearchResults } from "./types";

/** How long typing pauses before the search runs (the old 250 ms). */
const TYPING_MS = 250;
/** How often opened ignored folders are read again: the watch leaves ignored files out [D1002]. */
const IGNORED_MS = 3000;
const NO_MARKS: ChangeMarks = { files: {}, folders: {} };
const OFFLINE = "Not connected. Try again when it's back.";

const failure = (reply: Record<string, any>) => (reply.error === "disconnected" ? OFFLINE : String(reply.error));

export function FilesView({ owner, shown = null, onOpen }: { owner: string; shown?: string | null; onOpen: OnOpen }) {
  const { target, version } = useGit();
  const { daemon } = useDaemon();
  const key = target && JSON.stringify(target);
  const [listing, setListing] = useState<Listing>({ state: "loading" });
  const [marks, setMarks] = useState<ChangeMarks>(NO_MARKS);
  const [loaded, setLoaded] = useState<Record<string, FolderEntry[]>>({});
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[] | null>(null);
  const asked = useRef(0);

  useEffect(() => {
    setListing({ state: "loading" });
    setMarks(NO_MARKS);
    setLoaded({});
  }, [key]);
  // Listed again on each watch read that changed something; disconnected, the last listing stays [D30].
  useEffect(() => {
    if (!target || !daemon) return;
    let live = true;
    ask({ op: "run", args: sourceArgs(target, "files") }, (reply) => {
      if (!live || reply.error === "disconnected") return;
      if (!reply.ok) return setListing({ state: "failed", error: String(reply.error) });
      const { marks: next, ...list } = reply.list;
      setListing({ state: "listed", list });
      setMarks(next);
    });
    return () => void (live = false);
  }, [key, daemon, version]);

  const readIgnored = useCallback(
    (paths: string[]) => {
      if (!target) return;
      for (const path of paths)
        ask({ op: "run", args: sourceArgs(target, "folder", path) }, (reply) => {
          if (reply.error === "disconnected") return;
          // A folder that went is shown empty until the listing drops it.
          setLoaded((last) => ({ ...last, [path]: reply.ok ? reply.entries : [] }));
        });
    },
    [key],
  );
  // shortcut: opened ignored folders are read again every few seconds while shown; a watch of its own would be instant.
  const opened = Object.keys(loaded).join("\n");
  useEffect(() => {
    if (!opened || !daemon) return;
    const again = () => document.visibilityState === "visible" && readIgnored(opened.split("\n"));
    again();
    const timer = setInterval(again, IGNORED_MS);
    return () => clearInterval(timer);
  }, [opened, daemon, version, readIgnored]);

  // The filename search, in Rust over every listed file; an answer to an older query is dropped.
  useEffect(() => {
    if (!query || !target) return setResults(null);
    const at = ++asked.current;
    ask({ op: "run", args: sourceArgs(target, "find", query) }, (reply) => {
      if (at === asked.current && reply.ok) setResults(reply.found);
    });
  }, [query, key, version]);

  return (
    <FileTree
      scope={owner}
      listing={listing}
      marks={marks}
      loaded={loaded}
      onReadIgnored={readIgnored}
      shown={shown}
      results={query ? results : null}
      onQuery={setQuery}
      onOpen={onOpen}
    />
  );
}

/** The one search this connection runs: where its found files go [D1003]. */
let found: { re: number; add: (files: SearchFile[]) => void } | null = null;
setFoundHandler((frame) => {
  if (found && found.re === frame.found) found.add(frame.files);
});

export function SearchView({ onOpen }: { onOpen: (path: string, line: number, keep: boolean) => void }) {
  const { target } = useGit();
  const { daemon } = useDaemon();
  const where = target && JSON.stringify(target);
  const [form, setForm] = useState<SearchForm>(() => ({ ...EMPTY_FORM, details: detailsShown }));
  const [results, setResults] = useState<SearchResults | null>(null);
  const dismissed = useRef<ReadonlySet<string>>(new Set());
  const [asked, setAsked] = useState(0);
  // Keyed on what the query asks, as in the old app: typing in Replace doesn't search again.
  const query = searchQuery(form);
  const key = query ? JSON.stringify(query) : "";
  useEffect(() => {
    if (!key || !target) return setResults(null);
    const next = JSON.parse(key) as SearchQuery;
    // The last results stay, Searching…, until this search's first files or its end [D30].
    setResults((last) => (last ? { ...last, done: null, error: null } : { query: next, files: [], done: null, error: null, filteredFiles: 0 }));
    let first = true;
    const take = (files: SearchFile[]) => {
      const kept = files.filter((file) => !dismissed.current.has(file.path));
      setResults((last) => {
        const before = first || !last ? { query: next, files: [], done: null, error: null, filteredFiles: 0 } : last;
        first = false;
        return { ...before, files: [...before.files, ...kept], filteredFiles: before.filteredFiles + files.length - kept.length };
      });
    };
    const mine = { re: 0, add: take };
    const timer = setTimeout(() => {
      found = mine;
      mine.re = ask({ op: "grep", ...target, query: next }, (reply) => {
        if (found !== mine) return;
        found = null;
        if (reply.ok) {
          take([]);
          setResults((last) => last && { ...last, done: reply.done });
        } else setResults((last) => ({ ...(last ?? { files: [], filteredFiles: 0 }), query: next, done: null, error: failure(reply) }));
      });
    }, TYPING_MS);
    return () => {
      clearTimeout(timer);
      // The daemon stops it once a newer one starts; its last answers are dropped here.
      if (found === mine) found = null;
    };
  }, [key, asked, where, daemon]);

  const replace = (file?: string) =>
    new Promise<ReplaceOutcome>((resolve, reject) => {
      if (!results || !target) return reject(new Error("Nothing to replace"));
      const files = results.files.filter((each) => !file || each.path === file).map(({ path, hash, matches }) => ({ path, hash, matches }));
      ask({ op: "run", args: sourceArgs(target, "replace", JSON.stringify(results.query), form.replace, JSON.stringify(files)) }, (reply) => {
        if (!reply.ok) return reject(new Error(failure(reply)));
        // The old app found again after a replace changed the checkout.
        setAsked((count) => count + 1);
        resolve(reply.outcome);
      });
    });

  return (
    <SearchPanel
      form={form}
      onForm={(change) => setForm((last) => ({ ...last, ...change }))}
      results={results}
      onSearch={() => {
        dismissed.current = new Set();
        setAsked((count) => count + 1);
      }}
      onReplace={replace}
      // Gone from the results at once, as in the old app; searches until Enter leave it out.
      onDismiss={(path) => {
        dismissed.current = new Set([...dismissed.current, path]);
        setResults((last) => last && { ...last, files: last.files.filter((file) => file.path !== path), filteredFiles: last.filteredFiles + 1 });
      }}
      onOpen={onOpen}
    />
  );
}
