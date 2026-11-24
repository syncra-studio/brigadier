import { type ReactNode, useEffect, useMemo, useState } from "react";

import { CopyButton } from "../components/copy-button";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { Segmented } from "../components/segmented";
import { Skeleton } from "../components/skeleton";
import { FolderOpen } from "../icons";
import { FileIcon } from "../icons/file-types";
import { matches as isShortcut } from "../shortcuts";
import { ask } from "../daemon";
import { readFrom, sourceArgs, type Target, useGit } from "../panel/git";
import { openFile } from "../shell/tab-store";
import { FileLinks, Markdown } from "../thread/markdown";
import "../thread/markdown.css";
import { CodeLines } from "./code-lines";
import { baseName, dirName } from "./tree";
import type { FileRead } from "./types";

/**
 * A file tab, ported from the old FileTabView [D48, D1002]: one of the checkout's files, read only, with its line
 * numbers and colours, ⌘F to find in it and ⌃G to go to a line. It opens as a main-area tab [D1032]; Rust reads the
 * file (step 2.17), so this view only shows `read`.
 */

const MB = 1024 * 1024;
const MARKDOWN = /\.(md|markdown|mdx)$/i;
type View = "formatted" | "source";
const VIEWS = [
  { value: "formatted", label: "Formatted" },
  { value: "source", label: "Source" },
] as const;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / (1024 * MB)).toFixed(1)} GB`;
}

/** `href` from the file at `path`, as a checkout path: from its folder, or the root for `/…`; never above the root. */
function within(path: string, href: string): string {
  // Each folder's name escaped, so a `#`, `?` or `%` in it is its name's.
  const dir = dirName(path).split("/").map(encodeURIComponent).join("/");
  const at = new URL(href, `file:///${dir && `${dir}/`}`).pathname.slice(1);
  try {
    return decodeURIComponent(at);
  } catch {
    return at;
  }
}

/** A checkout image as a `data:` URL, read by Rust inside the checkout as the file itself is, links followed [D1002]. */
const imageUrl = (target: Target | null, path: string) =>
  new Promise<string | null>((done) => (target ? ask({ op: "run", args: sourceArgs(target, "image", path) }, (reply) => done(reply.ok ? reply.url : null)) : done(null)));

export function FileViewer({
  owner,
  path,
  read,
  line = null,
  reveal = 0,
  active,
  onReveal,
}: {
  /** Whose checkout the file is in, so its relative links and images are its; left out for a file that isn't a checkout's. */
  owner?: string;
  /** The file's path in the checkout. */
  path: string;
  read: FileRead;
  /** A line to mark and bring into view, asked again with a new `reveal`. */
  line?: number | null;
  reveal?: number;
  /** The tab is in front: ⌘F and ⌃G are its. */
  active: boolean;
  /** Shows the file in Finder; left out where there's nothing to show. */
  onReveal?: () => void;
}) {
  const file = read.state === "read" ? read.file : null;
  // A read that answers within a moment shows with no skeleton before it, as VS Code's does [D1310].
  const [slow, setSlow] = useState(false);
  const loading = read.state === "loading";
  useEffect(() => {
    setSlow(false);
    if (!loading) return;
    const timer = setTimeout(() => setSlow(true), 150);
    return () => clearTimeout(timer);
  }, [loading, path]);
  // A markdown file opens drawn, as the thread draws it; a line asked for, ⌘F or ⌃G shows its source, where they work.
  const markdown = MARKDOWN.test(path);
  const [view, setView] = useState<View>(line === null ? "formatted" : "source");
  const asked = `${path}:${line}:${reveal}`;
  const [seen, setSeen] = useState(asked);
  if (seen !== asked) {
    setSeen(asked);
    if (line !== null || !seen.startsWith(`${path}:`)) setView(line === null ? "formatted" : "source");
  }
  const formatted = markdown && view === "formatted";
  const { target: watched, version } = useGit();
  const target = readFrom(watched);
  const from = target && JSON.stringify(target);
  // New on each watch read that changed something, so an image made or changed since is read again.
  const links = useMemo(
    () => (owner === undefined ? null : { open: (href: string) => openFile(owner, within(path, href), { preview: true }), image: (src: string) => imageUrl(target, within(path, src)) }),
    [owner, path, from, version],
  );
  useEffect(() => {
    if (!active || !formatted) return;
    // Left for CodeLines, mounted hidden, to open its find or go-to-line box.
    const onKeyDown = (event: KeyboardEvent) => (isShortcut(event, "find") || isShortcut(event, "go-to-line")) && setView("source");
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, formatted]);
  return (
    <div data-slot="file-tab" className="flex min-h-0 flex-1 flex-col">
      <CodeFileHeader path={path} gone={read.state === "gone"} onReveal={onReveal}>
        {markdown && file?.text != null && <Segmented label="View" value={view} options={VIEWS} onChange={setView} />}
        {file && <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(file.size)}</span>}
      </CodeFileHeader>
      {loading && !slow ? (
        <div aria-busy className="flex-1" />
      ) : loading ? (
        <div aria-busy className="flex flex-col gap-2 px-4 py-3">
          {["w-1/3", "w-1/2", "w-2/5", "w-3/5", "w-1/4", "w-1/2"].map((width, index) => (
            // The same widths repeat; their order never changes.
            <Skeleton key={index} className={`h-3 ${width}`} />
          ))}
        </div>
      ) : read.state === "gone" ? (
        <p className="m-auto p-4 text-sm text-muted-foreground">{read.carried ? "This file isn't in this session's copy" : "This file was deleted or moved"}</p>
      ) : read.state === "failed" ? (
        <ErrorLine size="sm" error={read.error} className="p-4" />
      ) : file!.text === null ? (
        <p className="p-4 text-sm text-muted-foreground">Binary file not shown</p>
      ) : (
        <>
          {file!.truncated && (
            <p className="shrink-0 border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
              Showing the first {formatBytes(file!.text.length)} of {formatBytes(file!.size)}
            </p>
          )}
          {formatted && (
            <div data-selectable className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-reading px-6 py-6 text-chat text-chat-foreground">
                <FileLinks value={links}>
                  <Markdown text={file!.text} keep={`file:${path}`} />
                </FileLinks>
              </div>
            </div>
          )}
          <div className={cx("flex min-h-0 flex-1 flex-col", formatted && "hidden")}>
            <CodeLines text={file!.text} path={path} line={line} reveal={reveal} active={active} />
          </div>
        </>
      )}
    </div>
  );
}

/** A file's header: its icon, its name bold and its folder grey, then `children`, Copy path, Reveal in Finder and `actions`. */
export function CodeFileHeader({ path, gone, onReveal, children, actions }: { path: string; gone: boolean; onReveal?: () => void; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header data-slot="code-file-header" className="flex h-panel-header shrink-0 items-center gap-2 border-b border-border px-4">
      <FileIcon name={path} />
      <h2 className="min-w-0 flex-1 truncate text-sm" title={path}>
        <span className="font-medium">{baseName(path)}</span>
        {dirName(path) && <span className="text-muted-foreground"> {dirName(path)}</span>}
      </h2>
      {children}
      <CopyButton text={path} tooltip="Copy path" size="icon-sm" />
      {onReveal && (
        <TooltipIconButton tooltip="Reveal in Finder" size="icon-sm" disabled={gone} onClick={onReveal}>
          <FolderOpen />
        </TooltipIconButton>
      )}
      {actions}
    </header>
  );
}
