import { type KeyboardEvent, memo, type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";

import { TooltipIconButton } from "../components/icon-button";
import { ChevronDown, ChevronRight, X } from "../icons";
import { FileIcon } from "../icons/file-types";
import { CompareArrows } from "./icons";
import { baseName, dirName } from "./tree";
import type { SearchFile, SearchLine } from "./types";

/** Opens `path` at `line`: in the preview tab, or with `keep` in a tab of its own. */
export type OnOpenLine = (path: string, line: number, keep: boolean) => void;

/** One row of the results: a file's, or one of its matching lines. */
type Row = { type: "file"; file: SearchFile } | { type: "line"; file: SearchFile; line: SearchLine };

const rowKey = (row: Row) => (row.type === "file" ? row.file.path : `${row.file.path}:${row.line.line}`);

/**
 * The results as rows, only those in view drawn. One row takes the keyboard (Tab lands on it): the arrow keys move
 * it, Left closes a file or goes up to it, Right opens a file, Home and End go to either end, Delete or Backspace on a
 * file dismisses it.
 */
export function ResultList({
  files,
  collapsed,
  onToggle,
  onOpen,
  onReplace,
  onDismiss,
}: {
  files: SearchFile[];
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpen: OnOpenLine;
  onReplace: ((path: string) => void) | null;
  onDismiss: (path: string) => void;
}) {
  const rows = useMemo(() => {
    const list: Row[] = [];
    for (const file of files) {
      list.push({ type: "file", file });
      if (!collapsed.has(file.path)) for (const line of file.lines) list.push({ type: "line", file, line });
    }
    return list;
  }, [files, collapsed]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useRef<VirtualizerHandle>(null);
  const [active, setActive] = useState(0);
  const current = Math.max(0, Math.min(active, rows.length - 1));
  // A key moved the keyboard's row: it's brought into view, then focused once drawn.
  const focusing = useRef(false);
  const focusRun = useRef(0);
  useLayoutEffect(() => {
    if (!focusing.current) return;
    focusing.current = false;
    const run = ++focusRun.current;
    const focus = (tries: number) => {
      if (run !== focusRun.current) return;
      const next = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${current}"] [data-row-button]`);
      (next ?? scrollRef.current?.querySelector<HTMLElement>('[role="tree"]'))?.focus();
      // virtua hides a row until it's measured, and a hidden row can't take focus: try again next frame.
      if (next && document.activeElement !== next && tries > 0) requestAnimationFrame(() => focus(tries - 1));
    };
    focus(10);
  });
  const move = (index: number) => {
    const next = Math.max(0, Math.min(index, rows.length - 1));
    focusing.current = true;
    setActive(next);
    virtualizer.current?.scrollToIndex(next);
  };
  const latestRows = useRef(rows);
  useLayoutEffect(() => {
    latestRows.current = rows;
  }, [rows]);
  const dismiss = useCallback(
    (path: string) => {
      const visible = latestRows.current;
      const index = visible.findIndex((row) => row.type === "file" && row.file.path === path);
      focusing.current = true;
      setActive(Math.max(0, Math.min(index, visible.filter((row) => row.file.path !== path).length - 1)));
      onDismiss(path);
    },
    [onDismiss],
  );
  const onKeyDown = (event: KeyboardEvent) => {
    const row = rows[current];
    if (!row || event.altKey || event.ctrlKey) return;
    if (row.type === "file" && (event.key === "Backspace" || (event.key === "Delete" && !event.metaKey))) {
      event.preventDefault();
      dismiss(row.file.path);
      return;
    }
    if (event.metaKey) return;
    let handled = true;
    if (event.key === "ArrowDown") move(current + 1);
    else if (event.key === "ArrowUp") move(current - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(rows.length - 1);
    else if (event.key === "ArrowRight" && row.type === "file") {
      if (collapsed.has(row.file.path)) onToggle(row.file.path);
      else move(current + 1);
    } else if (event.key === "ArrowLeft") {
      if (row.type === "line") move(rows.findLastIndex((other, index) => index < current && other.type === "file"));
      else if (!collapsed.has(row.file.path)) onToggle(row.file.path);
    } else handled = false;
    if (handled) event.preventDefault();
  };
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <div
        role="tree"
        tabIndex={-1}
        aria-label="Search results"
        onKeyDown={onKeyDown}
        onFocus={(event) => {
          const index = Number((event.target as HTMLElement).closest("[data-index]")?.getAttribute("data-index"));
          if (Number.isInteger(index)) setActive(index);
        }}
      >
        {/* The row with the keyboard stays drawn while it scrolls out of view, so it keeps focus. */}
        <Virtualizer ref={virtualizer} scrollRef={scrollRef} data={rows} keepMounted={rows.length ? [current] : []} bufferSize={240}>
          {(row: Row, index: number) => (
            <div key={rowKey(row)} role="treeitem" aria-level={row.type === "file" ? 1 : 2} data-index={index} data-kind={row.type}>
              {row.type === "file" ? (
                <FileRow file={row.file} open={!collapsed.has(row.file.path)} tabbable={index === current} onToggle={onToggle} onReplace={onReplace} onDismiss={dismiss} />
              ) : (
                <LineRow file={row.file} line={row.line} tabbable={index === current} onOpen={onOpen} />
              )}
            </div>
          )}
        </Virtualizer>
      </div>
    </div>
  );
}

const FileRow = memo(function FileRow({
  file,
  open,
  tabbable,
  onToggle,
  onReplace,
  onDismiss,
}: {
  file: SearchFile;
  open: boolean;
  tabbable: boolean;
  onToggle: (path: string) => void;
  onReplace: ((path: string) => void) | null;
  onDismiss: (path: string) => void;
}) {
  return (
    <div className="group/file flex h-control-sm items-center rounded-control hover:bg-muted">
      <button
        type="button"
        data-row-button
        title={file.path}
        aria-expanded={open}
        tabIndex={tabbable ? 0 : -1}
        onClick={() => onToggle(file.path)}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-control ps-1 text-start text-sm focus-visible:focus-ring"
      >
        {open ? <ChevronDown className="size-icon-xs shrink-0" /> : <ChevronRight className="size-icon-xs shrink-0" />}
        <FileIcon name={file.path} />
        {/* A long name shrinks only once its folder has gone. */}
        <span className="min-w-0 truncate">{baseName(file.path)}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{dirName(file.path)}</span>
      </button>
      {/* Shown while the row is hovered or holds the keyboard. */}
      <span className="hidden group-focus-within/file:flex group-hover/file:flex">
        {onReplace && (
          <TooltipIconButton tooltip="Replace in this file" size="icon-xs" tabIndex={tabbable ? 0 : -1} onClick={() => onReplace(file.path)}>
            <CompareArrows />
          </TooltipIconButton>
        )}
        <TooltipIconButton tooltip="Dismiss" size="icon-xs" tabIndex={tabbable ? 0 : -1} onClick={() => onDismiss(file.path)}>
          <X />
        </TooltipIconButton>
      </span>
      <span className="me-1 shrink-0 rounded-capsule bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">{file.matches}</span>
    </div>
  );
});

const LineRow = memo(function LineRow({ file, line, tabbable, onOpen }: { file: SearchFile; line: SearchLine; tabbable: boolean; onOpen: OnOpenLine }) {
  return (
    <button
      type="button"
      data-row-button
      title={`${file.path}:${line.line}`}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => onOpen(file.path, line.line, false)}
      onDoubleClick={() => onOpen(file.path, line.line, true)}
      className="flex h-control-sm w-full cursor-pointer items-center rounded-control ps-8 pe-2 text-start text-sm hover:bg-muted focus-visible:focus-ring"
    >
      <Preview line={line} />
    </button>
  );
});

/** A result line with its matches marked. */
function Preview({ line }: { line: SearchLine }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [index, range] of line.ranges.entries()) {
    if (range.start > at) parts.push(line.preview.slice(at, range.start));
    parts.push(
      <mark key={index} className="rounded-xs bg-find-match text-inherit">
        {line.preview.slice(range.start, range.end)}
      </mark>,
    );
    at = range.end;
  }
  parts.push(line.preview.slice(at));
  return <span className="min-w-0 truncate whitespace-pre text-muted-foreground">{parts}</span>;
}
