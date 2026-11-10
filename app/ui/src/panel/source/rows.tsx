import { type ReactNode, useState } from "react";

import { cx } from "../../components/cx";
import { TooltipIconButton } from "../../components/icon-button";
import { ChevronDown, ChevronRight, FileDocument, FileIcon, Minus, Plus, Undo } from "../../icons";
import type { Commit, SourceFile } from "../types";
import { LETTERS } from "../status";
import { ago, baseName, dirName } from "../words";

/** A group of files under its title and count, folding away; its actions show on hover (the old SourceGroup). */
export function SourceGroup({ title, count, actions, defaultOpen = true, children }: { title: string; count: number; actions?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section aria-label={title} className="mt-2">
      <header className="group/source-group flex h-control-sm items-center gap-1 pe-1 text-sm">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-start focus-visible:focus-ring">
          {open ? <ChevronDown className="size-icon-sm shrink-0 text-muted-foreground" /> : <ChevronRight className="size-icon-sm shrink-0 text-muted-foreground" />}
          <span className="truncate">{title}</span>
        </button>
        <span className="hidden shrink-0 items-center group-focus-within/source-group:flex group-hover/source-group:flex">{actions}</span>
        <span className="rounded-capsule bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">{count}</span>
      </header>
      {open && <ul>{children}</ul>}
    </section>
  );
}

/** A row's or group's small action. */
export function RowButton({ tooltip, disabled, onClick, children }: { tooltip: string; disabled?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <TooltipIconButton tooltip={tooltip} size="icon-xs" disabled={disabled} onClick={onClick}>
      {children}
    </TooltipIconButton>
  );
}

export type RowActions = {
  onOpen?: () => void;
  onOpenFile?: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
};

/**
 * A changed file: a click opens its diff (a conflicted one its conflict view); its actions show on hover. `pending`:
 * moved here at once, its actions off until Rust answers [D30].
 */
export function FileRow({ file, group, selected = false, locked = false, pending = false, actions = {} }: {
  file: SourceFile;
  group: "merge" | "staged" | "changes";
  selected?: boolean;
  locked?: boolean;
  pending?: boolean;
  actions?: RowActions;
}) {
  const status = LETTERS[file.status];
  const off = locked || pending;
  const title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return (
    <li
      aria-current={selected || undefined}
      aria-busy={pending || undefined}
      className={cx("group/source-row flex h-control-sm items-center gap-1 rounded-control pe-1 hover:bg-muted", selected && "bg-muted")}
    >
      <button type="button" title={title} onClick={actions.onOpen} className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm ps-2 text-start text-sm focus-visible:focus-ring">
        <FileIcon name={file.path} />
        {/* A long name gives way before the row's actions do; its folder takes what is left. */}
        <span className={cx("min-w-0 truncate", file.status === "deleted" && "line-through", file.status === "conflicted" && "text-destructive")}>{baseName(file.path)}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{dirName(file.path)}</span>
      </button>
      <span className="hidden shrink-0 items-center group-focus-within/source-row:flex group-hover/source-row:flex">
        {file.status !== "deleted" && (
          <RowButton tooltip="Open File" onClick={actions.onOpenFile}>
            <FileDocument />
          </RowButton>
        )}
        {group === "changes" && (
          <RowButton tooltip="Discard Changes" disabled={off} onClick={actions.onDiscard}>
            <Undo />
          </RowButton>
        )}
        {group === "staged" ? (
          <RowButton tooltip="Unstage Changes" disabled={off} onClick={actions.onUnstage}>
            <Minus />
          </RowButton>
        ) : (
          <RowButton tooltip="Stage Changes" disabled={off} onClick={actions.onStage}>
            <Plus />
          </RowButton>
        )}
      </span>
      <span title={status.label} className={cx("w-4 shrink-0 text-center font-mono text-xs font-medium", status.className)}>
        {status.letter}
      </span>
    </li>
  );
}

/** The session's commits since its base, newest first [D1041]: read-only, a click opens the commit's diff. */
export function CommitsGroup({ commits, base, nowMs, selected, onOpen }: { commits: Commit[]; base: string; nowMs: number; selected?: string; onOpen?: (sha: string) => void }) {
  return (
    <SourceGroup title="Commits" count={commits.length} actions={<RowButton tooltip={`Open all commits since ${base}`}>
      <FileDocument />
    </RowButton>}>
      {commits.map((commit) => (
        <li key={commit.sha}>
          <button
            type="button"
            aria-current={selected === commit.sha || undefined}
            title={`${commit.sha} · ${ago(commit.atMs, nowMs)}`}
            onClick={() => onOpen?.(commit.sha)}
            className={cx("flex w-full cursor-pointer flex-col gap-0.5 rounded-control py-1 ps-6 pe-1 text-start hover:bg-muted focus-visible:focus-ring", selected === commit.sha && "bg-muted")}
          >
            <span className="w-full truncate text-sm">{commit.subject}</span>
            <span className="flex w-full items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-mono">{commit.sha}</span>
              <span>·</span>
              <span>{ago(commit.atMs, nowMs)}</span>
              <span className="flex-1" />
              <span className="font-mono tabular-nums">
                <span className="text-success">+{commit.added}</span> <span className="text-destructive">−{commit.removed}</span>
              </span>
            </span>
          </button>
        </li>
      ))}
    </SourceGroup>
  );
}
