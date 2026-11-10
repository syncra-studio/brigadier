import { Children, createContext, isValidElement, type ReactElement, type ReactNode, use, useEffect, useRef, useState } from "react";

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
      {open && <FileList>{children}</FileList>}
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

type RowProps = {
  file: SourceFile;
  /** Some of its changes are staged, some not, or both (then it offers Stage and Unstage). */
  staged?: boolean;
  unstaged?: boolean;
  /** Committed since the base, nothing left in the working tree: only Open File. */
  committed?: boolean;
  selected?: boolean;
  locked?: boolean;
  pending?: boolean;
  actions?: RowActions;
};

type Picked = { path: string; row: HTMLElement };

const PickMenu = createContext<(picked: Picked) => void>(() => {});

/**
 * A list of FileRows and their right-click menu: one menu for the list, filled by the row it opened on. A menu per row
 * made a long list slow to mount, so the panel stuttered while sliding open [D1156]. The menu reads that row's props
 * as they are now, so a lock or a move shows in it at once, and it closes if the row goes.
 * `held`: the gallery holds the first row's menu open there.
 */
export function FileList({ held, children }: { held?: HTMLElement; children: ReactNode }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const row = picked && Children.toArray(children).find((child): child is ReactElement<RowProps> => isValidElement<RowProps>(child) && child.props.file?.path === picked?.path);
  // Its row went (the file's no longer changed): the menu's done, and won't come back with the file.
  if (picked && !row) {
    setPicked(null);
    setOpen(false);
  }
  // Held open in the gallery there's no right-click: the first row is right-clicked for it, and its menu hangs from it.
  useEffect(() => {
    if (held) list.current?.querySelector("button")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  }, [held]);
  return (
    <PickMenu value={setPicked}>
      <ContextMenu open={(open || held !== undefined) && !!row} onOpenChange={setOpen}>
        <ContextMenuTrigger render={<ul ref={list} className="flex flex-col" />}>{children}</ContextMenuTrigger>
        <ContextMenuContent
          finalFocus={() => {
            // Back to its row, unless the click that closed it went to another control.
            const at = picked?.row.ownerDocument.activeElement;
            return !at || at === document.body || at.closest('[data-slot="context-menu-content"]') ? (picked?.row ?? true) : false;
          }}
          {...(held && picked && { container: held, anchor: picked.row, side: "bottom", align: "start", collisionAvoidance: { side: "none", align: "none" } as const })}
        >
          {row && <MenuItems {...row.props} />}
        </ContextMenuContent>
      </ContextMenu>
    </PickMenu>
  );
}

/** Open File, Stage or Unstage, and Discard: what a row's right-click offers. */
function MenuItems({ file, staged = false, unstaged = !staged, committed = false, locked = false, pending = false, actions = {} }: RowProps) {
  const off = locked || pending;
  return (
    <>
      {file.status !== "deleted" && <ContextMenuItem onClick={actions.onOpenFile}>Open File</ContextMenuItem>}
      {!committed && (
        <>
          {unstaged && (
            <ContextMenuItem disabled={off} onClick={actions.onStage}>
              Stage
            </ContextMenuItem>
          )}
          {staged && (
            <ContextMenuItem disabled={off} onClick={actions.onUnstage}>
              Unstage
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem disabled={off} onClick={actions.onDiscard}>
            Discard Changes…
          </ContextMenuItem>
        </>
      )}
    </>
  );
}

/**
 * A changed file, one quiet row [D1098, D1103, D1110]: its icon, name and counts, its folder as the tooltip, a ✓ when
 * staged, a warning when conflicted. A click opens its diff (a conflicted one its conflict tab); a right-click opens
 * its FileList's menu. `pending`: moved at once, waiting for Rust's answer [D30].
 */
export function FileRow({ file, staged = false, committed = false, selected = false, pending = false, actions = {} }: RowProps) {
  const conflicted = file.status === "conflicted";
  const folder = dirName(file.path);
  const pick = use(PickMenu);
  return (
    <li>
      <button
        type="button"
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : folder || undefined}
        aria-current={selected || undefined}
        aria-busy={pending || undefined}
        onClick={actions.onOpen}
        onContextMenu={(event) => {
          // A deleted file that's committed has nothing to offer: no menu.
          if (committed && file.status === "deleted") return event.stopPropagation();
          pick({ path: file.path, row: event.currentTarget });
        }}
        className={cx(
          "flex h-control-sm w-full cursor-pointer items-center gap-2 rounded-control px-2 text-start text-sm hover:bg-muted focus-visible:focus-ring",
          selected && "bg-muted",
        )}
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
      </button>
    </li>
  );
}
