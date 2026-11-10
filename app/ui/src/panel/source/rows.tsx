import { type ReactNode, useRef, useState } from "react";

import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../../components/context-menu";
import { cx } from "../../components/cx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/tooltip";
import { Check, ChevronDown, ChevronRight, FileIcon, Spinner, Warning } from "../../icons";
import type { SourceFile } from "../types";
import { baseName, dirName } from "../words";

/** "+62 −8": lines added and removed, each only when there are some. */
export function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      {added > 0 && <span className="text-success">+{added}</span>} {removed > 0 && <span className="text-destructive">−{removed}</span>}
    </span>
  );
}

/** A quiet heading over the list: a name and its count. */
export function Heading({ title, count }: { title: string; count: number }) {
  return (
    <h3 className="flex h-control-xs items-center gap-1.5 px-2 text-xs font-normal text-muted-foreground">
      <span>{title}</span>
      <span className="tabular-nums">{count}</span>
    </h3>
  );
}

/** A heading that folds its rows away ("Merged cleanly" during a merge). */
export function Group({ title, count, defaultOpen = true, children }: { title: string; count: number; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section aria-label={title} className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-control-xs cursor-pointer items-center gap-1 rounded-control px-2 text-start text-xs text-muted-foreground hover:text-foreground focus-visible:focus-ring"
      >
        <span>{title}</span>
        <span className="tabular-nums">{count}</span>
        {open ? <ChevronDown className="size-icon-xs" /> : <ChevronRight className="size-icon-xs" />}
      </button>
      {open && <ul className="flex flex-col">{children}</ul>}
    </section>
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
 * A changed file, one quiet row [D1098, D1103, D1110]: its icon, name and counts, its folder as the tooltip, a ✓ when
 * staged, a warning when conflicted. A click opens its diff (a conflicted one its conflict tab); a right-click opens
 * Open File, Stage or Unstage, and Discard. `pending`: moved at once, waiting for Rust's answer [D30].
 * `held`: the gallery holds its menu open there.
 */
export function FileRow({ file, staged = false, selected = false, locked = false, pending = false, actions = {}, held }: {
  file: SourceFile;
  staged?: boolean;
  selected?: boolean;
  locked?: boolean;
  pending?: boolean;
  actions?: RowActions;
  held?: HTMLElement;
}) {
  const conflicted = file.status === "conflicted";
  const off = locked || pending;
  const folder = dirName(file.path);
  // Held open in the gallery there's no pointer to place it at: it hangs from the row.
  const row = useRef<HTMLLIElement>(null);
  return (
    <li ref={row}>
      <ContextMenu {...(held && { open: true })}>
        <ContextMenuTrigger
          render={
            <button
              type="button"
              title={file.oldPath ? `${file.oldPath} → ${file.path}` : folder || undefined}
              aria-current={selected || undefined}
              aria-busy={pending || undefined}
              onClick={actions.onOpen}
              className={cx(
                "flex h-control-sm w-full cursor-pointer items-center gap-2 rounded-control px-2 text-start text-sm hover:bg-muted focus-visible:focus-ring",
                selected && "bg-muted",
              )}
            />
          }
        >
          <FileIcon name={baseName(file.path)} size="sm" />
          <span className={cx("min-w-0 flex-1 truncate", file.status === "deleted" && "line-through")}>{baseName(file.path)}</span>
          {staged && (
            <Tooltip>
              <TooltipTrigger render={<span className="flex shrink-0 text-muted-foreground svg:size-icon-xs" />}>
                <Check />
              </TooltipTrigger>
              <TooltipContent>Staged</TooltipContent>
            </Tooltip>
          )}
          {pending ? (
            <Spinner className="size-icon-xs shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
          ) : conflicted ? (
            <Warning aria-label="Conflicted" className="size-icon-sm shrink-0 text-warning" />
          ) : (
            <Counts added={file.added} removed={file.removed} />
          )}
        </ContextMenuTrigger>
        <ContextMenuContent {...(held && { container: held, anchor: row, side: "bottom", align: "start", collisionAvoidance: { side: "none", align: "none" } as const })}>
          {file.status !== "deleted" && <ContextMenuItem onClick={actions.onOpenFile}>Open File</ContextMenuItem>}
          <ContextMenuItem disabled={off} onClick={staged ? actions.onUnstage : actions.onStage}>
            {staged ? "Unstage" : "Stage"}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={off} onClick={actions.onDiscard}>
            Discard Changes…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}
