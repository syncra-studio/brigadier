// Files as the panel mounts it (panel/views.tsx), on the on-screen checkout's Rust reads [D1002]: the tree's
// listing, marks and filename search, and an ignored folder's contents.
import { useCallback, useEffect, useRef, useState } from "react";

import { showToast } from "../components/toast";
import { ask, useDaemon } from "../daemon";
import { useStart } from "../home/start";
import { keep, sourceArgs, type Target, useGit } from "../panel/git";
import { HOME } from "../shell/tab-store";
import { FileTree, type OnOpen } from "./tree";
import type { ChangeMarks, FolderEntry, Listing } from "./types";

/** How often the listing and opened ignored folders are read again while shown: the watch leaves ignored files out [D1002]. */
const IGNORED_MS = 3000;
const NO_MARKS: ChangeMarks = { files: {}, folders: {} };

// Each checkout's last listing, shown at once on coming back to it while it's listed again, as the checkout's git read is (panel/git.ts) [D1258].
const kept = new Map<string, { listing: Listing; marks: ChangeMarks }>();

/** Whose files `owner`'s Files reads: none until the watch is on it [D1258]. A folder chat's watch is one of its repos, `<owner>@<repo>` [D494]; its Files are all its repos, the chat's own [D776]. */
function filesTarget(watched: Target | null, owner: string): Target | null {
  return watched && ("session" in watched ? (watched.session.split("@")[0] === owner ? { session: owner } : null) : owner === HOME ? watched : null);
}

/** Reads `owner`'s listing ahead while Files is closed, so it opens on it at once; a folder chat's every repo too [D881]. */
export function useFilesAhead(owner: string, skip: boolean): void {
  const { target: watched } = useGit();
  const { daemon } = useDaemon();
  const target = filesTarget(watched, owner);
  const key = target && JSON.stringify(target);
  const starting = useStart(owner)?.asking === true;
  useEffect(() => {
    if (skip || !target || !key || !daemon || starting || kept.has(key)) return;
    const read = (repos: string[]) =>
      ask({ op: "run", args: sourceArgs(target, "files", ...repos) }, (reply) => {
        if (!reply.ok) return;
        const { marks, ...list } = reply.list;
        keep(kept, key, { listing: { state: "listed", list }, marks });
        if (list.repos?.length && !repos.length) read(list.repos);
      });
    read([]);
  }, [key, daemon, starting, skip]);
}

export function FilesView({ owner, shown = null, onOpen }: { owner: string; shown?: string | null; onOpen: OnOpen }) {
  const { target: watched, version } = useGit();
  const { daemon } = useDaemon();
  // Mounted on a switch, this view renders once before the watch moves to its owner: another checkout's, never read here [D1258].
  const target = filesTarget(watched, owner);
  const key = target && JSON.stringify(target);
  const [listing, setListing] = useState<Listing>(() => (key && kept.get(key)?.listing) || { state: "loading" });
  const [marks, setMarks] = useState<ChangeMarks>(() => (key && kept.get(key)?.marks) || NO_MARKS);
  const [loaded, setLoaded] = useState<Record<string, FolderEntry[]>>({});
  // Set in the render, not an effect, so the paint never shows the last checkout's tree or a frame of loading [D1258].
  const [listed, setListed] = useState(key);
  if (listed !== key) {
    setListed(key);
    setListing((key && kept.get(key)?.listing) || { state: "loading" });
    setMarks((key && kept.get(key)?.marks) || NO_MARKS);
    setLoaded({});
  }
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[] | null>(null);
  const asked = useRef(0);
  const [tick, setTick] = useState(0);
  // shortcut: a folder chat lists every repo on each read (Rust reads them at once), so opening one draws what's
  // already here [D881]; list only the open ones and keep the rest if a folder of many repos is slow.
  const repos = (listing.state === "listed" && listing.list.repos?.join("\n")) || "";
  // A new session's checkout isn't made until its start answers: the listing waits, loading, as the watch does [D1259].
  const starting = useStart(owner)?.asking === true;

  // Listed again on each watch read that changed something; disconnected, the last listing stays [D30].
  useEffect(() => {
    if (!target || !daemon || starting) return;
    let live = true;
    ask({ op: "run", args: sourceArgs(target, "files", ...(repos ? repos.split("\n") : [])) }, (reply) => {
      if (!live || reply.error === "disconnected") return;
      if (!reply.ok) return setListing({ state: "failed", error: String(reply.error) });
      const { marks: next, ...list } = reply.list;
      if (key) keep(kept, key, { listing: { state: "listed", list }, marks: next });
      // The same listing keeps its objects, so the tree isn't built again.
      setListing((last) => (last.state === "listed" && JSON.stringify(last.list) === JSON.stringify(list) ? last : { state: "listed", list }));
      setMarks((last) => (JSON.stringify(last) === JSON.stringify(next) ? last : next));
      // An opened ignored folder that's no longer there goes, with what was read under it.
      const roots = (list.ignored as string[]).filter((entry) => entry.endsWith("/"));
      setLoaded((last) => {
        const kept = Object.entries(last).filter(([path]) => roots.some((root) => `${path}/`.startsWith(root)));
        return kept.length === Object.keys(last).length ? last : Object.fromEntries(kept);
      });
    });
    return () => void (live = false);
  }, [key, daemon, version, tick, starting, repos]);

  const readIgnored = useCallback(
    (paths: string[]) => {
      if (!target) return;
      for (const path of paths)
        ask({ op: "run", args: sourceArgs(target, "folder", path) }, (reply) => {
          if (reply.error === "disconnected") return;
          // A folder that went goes, with what was read under it.
          setLoaded((last) =>
            reply.ok ? (JSON.stringify(last[path]) === JSON.stringify(reply.entries) ? last : { ...last, [path]: reply.entries }) : Object.fromEntries(Object.entries(last).filter(([each]) => each !== path && !each.startsWith(`${path}/`))),
          );
        });
    },
    // A new callback once reconnected, so the tree asks again for folders opened meanwhile.
    [key, daemon],
  );
  // shortcut: the listing (for a new ignored folder, which changes no status) and opened ignored folders are read again
  // every few seconds while shown; a watch of their own would be instant.
  const openFolders = Object.keys(loaded).join("\n");
  useEffect(() => {
    if (!daemon) return;
    const timer = setInterval(() => document.visibilityState === "visible" && setTick((n) => n + 1), IGNORED_MS);
    return () => clearInterval(timer);
  }, [daemon]);
  useEffect(() => {
    if (openFolders && daemon) readIgnored(openFolders.split("\n"));
  }, [openFolders, daemon, version, tick, readIgnored]);

  // The filename search, in Rust over every listed file; an answer to an older query is dropped.
  useEffect(() => {
    if (!query || !target) return setResults(null);
    const at = ++asked.current;
    ask({ op: "run", args: sourceArgs(target, "find", query) }, (reply) => {
      if (at === asked.current && reply.ok) setResults(reply.found);
    });
  }, [query, key, version]);

  // Rust keeps the path inside the checkout; a failure is a toast, as the project menu's Reveal in Finder (D1226).
  const reveal = useCallback(
    (path: string) =>
      target &&
      ask({ op: "run", args: sourceArgs(target, "reveal", path) }, (reply) => {
        if (!reply.ok) showToast(`Couldn't reveal ${path}: ${String(reply.error)}`, { tone: "error" });
      }),
    [key],
  );

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
      onReveal={reveal}
    />
  );
}
