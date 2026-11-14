import { type ReactNode, useEffect, useState } from "react";

import { CopyButton } from "../components/copy-button";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { Skeleton } from "../components/skeleton";
import { FolderOpen } from "../icons";
import { FileIcon } from "../icons/file-types";
import { CodeLines } from "./code-lines";
import { baseName, dirName } from "./tree";
import type { FileRead } from "./types";

/**
 * A file tab, ported from the old FileTabView [D48, D1002]: one of the checkout's files, read only, with its line
 * numbers and colours, ⌘F to find in it and ⌃G to go to a line. It opens as a main-area tab [D1032]; Rust reads the
 * file (step 2.17), so this view only shows `read`.
 */

const MB = 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / (1024 * MB)).toFixed(1)} GB`;
}

export function FileViewer({
  path,
  read,
  line = null,
  reveal = 0,
  active,
  onReveal,
}: {
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
  return (
    <div data-slot="file-tab" className="flex min-h-0 flex-1 flex-col">
      <CodeFileHeader path={path} gone={read.state === "gone"} onReveal={onReveal}>
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
          <CodeLines text={file!.text} path={path} line={line} reveal={reveal} active={active} />
        </>
      )}
    </div>
  );
}

/** A file's header: its icon, its name bold and its folder grey, then `children`, Copy path and Reveal in Finder. */
function CodeFileHeader({ path, gone, onReveal, children }: { path: string; gone: boolean; onReveal?: () => void; children?: ReactNode }) {
  return (
    <header data-slot="code-file-header" className="flex h-control-lg shrink-0 items-center gap-2 border-b border-border px-4 toggles-clear:pe-toggles-clear">
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
    </header>
  );
}
