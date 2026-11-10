import { memo, useEffect, useMemo, useRef, useState } from "react";

import { cx } from "../components/cx";
import { EmptyState } from "../components/empty-state";
import { ErrorLine } from "../components/error-line";
import { Skeleton } from "../components/skeleton";
import { ChevronDown, ChevronRight } from "../icons";
import { FileIcon } from "../icons/file-types";
import { LETTERS, type FileStatus } from "../panel/status";
import { PanelField } from "./field";
import type { ChangeMarks, FileList, FolderEntry, Listing } from "./types";

/**
 * The panel's Files (⇧⌘E), ported from the old FileBrowser [D48, D1002]: a checkout's files as a tree with a search
 * field. A click opens a file in the preview tab, a double click or Enter keeps it. Changed files take their status
 * letter and colour, a folder holding changes a dot; deleted files stay, struck through; ignored entries are dimmed,
 * and an ignored folder's contents are read when it opens.
 */

/** Opens `path`: in the preview tab, or with `keep` in a tab of its own. */
export type OnOpen = (path: string, keep: boolean) => void;

/** The folders open in each session's (or project folder's) tree, kept while the app runs. */
const openFolders = new Map<string, ReadonlySet<string>>();

export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const dirName = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

type Row =
  | { kind: "folder"; path: string; name: string; depth: number; open: boolean; ignored: boolean; status: FileStatus | undefined }
  | { kind: "file"; path: string; name: string; depth: number; ignored: boolean; status: FileStatus | undefined };

type Folder = { folders: Map<string, Folder>; files: string[]; ignored: boolean };
type Tree = { root: Folder; ignoredFiles: ReadonlySet<string> };

function folderAt(root: Folder, path: string): Folder {
  let folder = root;
  for (const part of path.split("/")) {
    let next = folder.folders.get(part);
    if (!next) folder.folders.set(part, (next = { folders: new Map(), files: [], ignored: false }));
    folder = next;
  }
  return folder;
}

/** The tree of the listed files, the ones deleted from the index too, and what the opened ignored folders hold. */
function buildTree(list: FileList, marks: ChangeMarks, loaded: Readonly<Record<string, FolderEntry[]>>): Tree {
  const root: Folder = { folders: new Map(), files: [], ignored: false };
  const listed = new Set(list.files);
  const add = (path: string) => {
    const slash = path.lastIndexOf("/");
    (slash < 0 ? root : folderAt(root, path.slice(0, slash))).files.push(path);
  };
  for (const path of list.files) add(path);
  for (const [path, status] of Object.entries(marks.files)) if (status === "deleted" && !listed.has(path)) add(path);
  const ignoredFiles = new Set<string>();
  for (const entry of list.ignored) {
    if (entry.endsWith("/")) folderAt(root, entry.slice(0, -1)).ignored = true;
    else {
      ignoredFiles.add(entry);
      add(entry);
    }
  }
  // In order, so a folder is there before what it holds.
  for (const [path, entries] of Object.entries(loaded).toSorted(([a], [b]) => a.length - b.length)) {
    const node = folderAt(root, path);
    for (const entry of entries) {
      const child = `${path}/${entry.name}`;
      if (entry.folder) folderAt(root, child).ignored = true;
      else if (!node.files.includes(child)) {
        ignoredFiles.add(child);
        node.files.push(child);
      }
    }
  }
  return { root, ignoredFiles };
}

/** The visible rows: folders first, then files, each by name; open folders expanded. An ignored folder's contents are ignored too. */
function visibleRows({ root, ignoredFiles }: Tree, open: ReadonlySet<string>, marks: ChangeMarks): Row[] {
  const rows: Row[] = [];
  const walk = (folder: Folder, prefix: string, depth: number, ignoredAbove: boolean) => {
    for (const name of [...folder.folders.keys()].toSorted((a, b) => a.localeCompare(b))) {
      const path = prefix ? `${prefix}/${name}` : name;
      const child = folder.folders.get(name)!;
      const ignored = ignoredAbove || child.ignored;
      const isOpen = open.has(path);
      rows.push({ kind: "folder", path, name, depth, open: isOpen, ignored, status: ignored ? undefined : marks.folders[path] });
      if (isOpen) walk(child, path, depth + 1, ignored);
    }
    for (const path of folder.files.toSorted((a, b) => baseName(a).localeCompare(baseName(b)))) {
      const ignored = ignoredAbove || ignoredFiles.has(path);
      rows.push({ kind: "file", path, name: baseName(path), depth, ignored, status: ignored ? undefined : marks.files[path] });
    }
  };
  walk(root, "", 0, false);
  return rows;
}

const NO_FOLDERS: Readonly<Record<string, FolderEntry[]>> = {};

export function FileTree({
  scope,
  listing,
  marks,
  loaded = NO_FOLDERS,
  onReadIgnored,
  shown = null,
  results,
  defaultQuery = "",
  onQuery,
  onOpen,
  searchRequest = 0,
  defaultOpen,
}: {
  /** Whose files: what the open folders are remembered under. */
  scope: string;
  listing: Listing;
  marks: ChangeMarks;
  /** What each opened ignored folder holds, read from disk. */
  loaded?: Readonly<Record<string, FolderEntry[]>>;
  /** Asks for the open ignored folders' contents (git doesn't list them). */
  onReadIgnored?: (paths: string[]) => void;
  /** The file the tab in front shows: its row lights up. */
  shown?: string | null;
  /** The files matching the query, best first; null with no query. */
  results: string[] | null;
  defaultQuery?: string;
  onQuery: (query: string) => void;
  onOpen: OnOpen;
  /** Counts up to put the keyboard in the search field (⌘P). */
  searchRequest?: number;
  /** The folders open before any was opened or closed here (the gallery's frozen states). */
  defaultOpen?: string[];
}) {
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searchRequest > 0) search.current?.focus({ preventScroll: true });
  }, [searchRequest]);
  const [query, setQuery] = useState(defaultQuery);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => openFolders.get(scope) ?? new Set(defaultOpen));
  const [active, setActive] = useState(0);
  const list = listing.state === "listed" ? listing.list : null;
  const rows = useMemo(() => (list ? visibleRows(buildTree(list, marks, loaded), open, marks) : []), [list, marks, loaded, open]);
  const openIgnored = rows.flatMap((row) => (row.kind === "folder" && row.open && row.ignored && !loaded[row.path] ? [row.path] : [])).join("\n");
  useEffect(() => {
    if (openIgnored) onReadIgnored?.(openIgnored.split("\n"));
  }, [openIgnored, onReadIgnored]);
  const found = query.trim() ? results : null;

  const toggle = (path: string) => {
    const next = new Set(open);
    if (!next.delete(path)) next.add(path);
    openFolders.set(scope, next);
    setOpen(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border p-2">
        <PanelField
          inputRef={search}
          label="Search files"
          value={query}
          onChange={(value) => {
            setQuery(value);
            setActive(0);
            onQuery(value.trim());
          }}
          onKeyDown={(event) => {
            if (!found) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((index) => Math.min(found.length - 1, Math.max(0, index + step)));
            } else if (event.key === "Enter") {
              const path = found[active];
              if (path) onOpen(path, true);
            }
          }}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {listing.state === "loading" ? (
          <div aria-busy className="flex flex-col gap-2 p-2">
            {["w-1/2", "w-2/3", "w-2/5", "w-3/5", "w-1/3"].map((width) => (
              <Skeleton key={width} className={cx("h-4", width)} />
            ))}
          </div>
        ) : listing.state === "failed" ? (
          <ErrorLine size="sm" error={`Couldn't list the files: ${listing.error}`} className="p-2" />
        ) : list!.files.length === 0 ? (
          <EmptyState title="No files" className="p-2" />
        ) : found ? (
          found.length === 0 ? (
            <EmptyState title="No matching files" className="p-2" />
          ) : (
            <ul aria-label="Matching files">
              {found.map((path, index) => (
                <li key={path}>
                  <button
                    type="button"
                    title={path}
                    data-active={index === active || undefined}
                    onClick={() => onOpen(path, false)}
                    onDoubleClick={() => onOpen(path, true)}
                    onPointerMove={() => setActive(index)}
                    className="flex h-control-md w-full cursor-pointer items-center gap-2 rounded-control px-2 text-start text-sm focus-visible:focus-ring data-active:bg-muted"
                  >
                    <FileIcon name={path} />
                    <span className="shrink-0">{baseName(path)}</span>
                    <span className="min-w-0 truncate text-muted-foreground">{dirName(path)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <ul aria-label="Files" role="tree">
            {rows.map((row) => (
              <TreeRow key={`${row.kind}:${row.path}`} row={row} selected={row.kind === "file" && row.path === shown} onToggle={toggle} onOpen={onOpen} />
            ))}
          </ul>
        )}
        {list?.truncated && !found && (
          <p className="p-2 text-xs text-muted-foreground">
            Only the first {list.files.length.toLocaleString()} files are listed. Search to find the others.
          </p>
        )}
      </div>
    </div>
  );
}

const TreeRow = memo(function TreeRow({ row, selected, onToggle, onOpen }: { row: Row; selected: boolean; onToggle: (path: string) => void; onOpen: OnOpen }) {
  const folder = row.kind === "folder";
  const mark = row.status ? LETTERS[row.status] : null;
  return (
    <li role="treeitem" aria-expanded={folder ? row.open : undefined} aria-selected={selected}>
      <button
        type="button"
        title={mark ? `${row.path} · ${mark.label}` : row.ignored ? `${row.path} · Ignored` : row.path}
        onClick={() => (folder ? onToggle(row.path) : onOpen(row.path, false))}
        onDoubleClick={() => !folder && onOpen(row.path, true)}
        // Each level indents by one step of the spacing scale (tree-indent, theme.css).
        data-depth={row.depth}
        className={cx(
          "tree-indent flex h-control-sm w-full cursor-pointer items-center gap-1.5 rounded-control pe-2 text-start text-sm hover:bg-muted focus-visible:focus-ring",
          mark ? mark.className : "text-foreground",
          row.ignored && "opacity-ignored",
          selected && "bg-muted",
        )}
      >
        {folder ? (
          row.open ? <ChevronDown className="size-icon-xs shrink-0" /> : <ChevronRight className="size-icon-xs shrink-0" />
        ) : (
          <FileIcon name={row.path} className="size-icon-xs shrink-0" />
        )}
        <span className={cx("min-w-0 flex-1 truncate", !folder && row.status === "deleted" && "line-through")}>{row.name}</span>
        {mark &&
          (folder ? (
            <span aria-hidden className="size-1.5 shrink-0 rounded-capsule bg-current" />
          ) : (
            <span aria-hidden className="w-3 shrink-0 text-center text-xs">{mark.letter}</span>
          ))}
      </button>
    </li>
  );
});
