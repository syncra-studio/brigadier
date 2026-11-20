import type { ReactNode } from "react";

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/context-menu";
import { cx } from "../components/cx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../components/menu";
import { RowAction } from "../components/row-action";
import { BranchAlt, ChevronDown, DotsHorizontal } from "../icons";
import { prList } from "../landing/pr-chip";
import { ago } from "../landing/pr-words";
import { closed } from "../sessions/archive";
import { ClosedMenuItems } from "../sessions/archived";
import { BrigadeGlyph } from "../sessions/brigade";
import { Labels } from "../sidebar/labels";
import { RowMenuItems } from "../sidebar/menu";
import { RowMark, URGENT } from "../sidebar/row";
import { type Mark, type SessionRow, statusWords } from "../sidebar/words";

/*
 * The Sessions tab's board [D3101, D3104]: one column per group the list has, its cards pinned first, then
 * as the list orders them. A card opens its session; there's no drag, since a column is Rust's state, not a choice.
 */

/** A session's menu on the page: the live row's, or the sidebar's Archived one for an archived row or a delete that left something [D35]. */
export const itemsOf = (row: SessionRow, onRename: (row: SessionRow) => void) => (closed(row) ? <ClosedMenuItems row={row} /> : <RowMenuItems row={row} onRename={() => onRename(row)} />);

/** The short age: 4m, 2h, 3d. */
export const shortAgo = (row: SessionRow, now: number) => ago(row.updated ?? row.sent, now).replace(/ (s|min|h|d) ago/, (_, unit: string) => unit[0]!);

/** A Brigade's sessions under it on the page, oldest first, folding with it; the page's folds are its own (proposed) [D189 D3108]. */
export type Tree = { kids: (row: SessionRow) => SessionRow[]; open: (id: string) => boolean; toggle: (id: string) => void };

const markOf = (row: SessionRow): Mark => (row.lifecycle?.left ? "amber" : row.mark);
/** Its own mark, or folded, the most pressing of its family's, as the sidebar's folded Brigade [D189]. */
export const familyMark = (row: SessionRow, kids: SessionRow[], open: boolean): Mark => (open ? [row] : [row, ...kids]).map(markOf).toSorted((a, b) => URGENT.indexOf(a) - URGENT.indexOf(b))[0]!;

/** The ⋯ button and its menu; its clicks and keys bubble through the portal to the row, so they stop here. */
export function MenuButton({ title, items }: { title: string; items: ReactNode }) {
  return (
    <span className="contents" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger render={<RowAction aria-label={`Actions for ${title}`} />}>
          <DotsHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">{items}</DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

export function Board({ columns, tree, now, onOpen, onRename }: { columns: [string, string, SessionRow[]][]; tree: Tree; now: number; onOpen: (id: string) => void; onRename: (row: SessionRow) => void }) {
  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-6 pb-4">
      {columns.map(([key, label, rows]) => (
        <section key={key} aria-label={label} className="flex max-w-80 min-w-48 flex-1 basis-0 flex-col">
          <h3 className="flex h-8 shrink-0 items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
            {label}
            <span className="tabular-nums">{rows.reduce((n, row) => n + 1 + tree.kids(row).length, 0)}</span>
          </h3>
          <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-surface bg-fill-subtle p-2">
            {rows.toSorted((a, b) => (b.pinned ?? 0) - (a.pinned ?? 0)).map((row) => (
              <Card key={row.id} row={row} tree={tree} now={now} onOpen={onOpen} onRename={onRename} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** A card: its title and menu, its labels, then its mark and words, PRs and age; a Brigade's sessions under it, each with its own menu and labels [D3108]. */
function Card({ row, tree, now, onOpen, onRename }: { row: SessionRow; tree: Tree; now: number; onOpen: (id: string) => void; onRename: (row: SessionRow) => void }) {
  const title = row.title || "New session";
  const words = statusWords(row) ?? "";
  const items = itemsOf(row, onRename);
  const kids = tree.kids(row);
  const open = tree.open(row.id);
  return (
    <li data-row-id={row.id} className="flex flex-col rounded-control border border-divider bg-background">
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              role="button"
              tabIndex={0}
              onClick={() => onOpen(row.id)}
              onKeyDown={(event) => event.key === "Enter" && onOpen(row.id)}
              className="flex cursor-pointer flex-col gap-2 rounded-control p-3 text-sm hover:bg-fill-subtle focus-visible:focus-ring"
            />
          }
        >
          <span className="flex items-start gap-2">
            {row.brigade && <BrigadeGlyph aria-label="Brigade" className="mt-0.5 size-icon-md shrink-0 text-muted-foreground" />}
            {row.forkOf && <BranchAlt aria-label="Fork" className="mt-0.5 size-icon-sm shrink-0 text-muted-foreground" />}
            <span title={title} className={cx("line-clamp-2 min-w-0 flex-1 font-medium wrap-anywhere", closed(row) ? "text-marker-foreground" : "text-foreground")}>
              {title}
            </span>
            <MenuButton title={title} items={items} />
          </span>
          <Labels row={row} className="flex flex-wrap gap-1" />
          <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
            <RowMark mark={familyMark(row, kids, open)} label={words} />
            <span className="min-w-0 flex-1 truncate">{words}</span>
            {row.pr && <span className="shrink-0">{prList(row.pr)}</span>}
            <span className="shrink-0 whitespace-nowrap">{shortAgo(row, now)}</span>
          </span>
        </ContextMenuTrigger>
        <ContextMenuContent>{items}</ContextMenuContent>
      </ContextMenu>
      {kids.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => tree.toggle(row.id)}
            className="flex h-7 cursor-pointer items-center gap-1.5 border-t border-divider px-3 text-xs text-muted-foreground hover:text-foreground focus-visible:focus-ring"
          >
            {kids.length} {kids.length === 1 ? "session" : "sessions"}
            <ChevronDown className={cx("size-icon-xs", !open && "-rotate-90")} />
          </button>
          {open && (
            <ul aria-label={`${title}'s sessions`} className="flex flex-col pb-1">
              {kids.map((sub) => (
                <SubCard key={sub.id} row={sub} now={now} onOpen={onOpen} onRename={onRename} />
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

/** A Brigade's session inside its card: its mark, title, age and menu, then its labels. */
function SubCard({ row, now, onOpen, onRename }: { row: SessionRow; now: number; onOpen: (id: string) => void; onRename: (row: SessionRow) => void }) {
  const title = row.title || "New session";
  const items = itemsOf(row, onRename);
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<li data-row-id={row.id} />}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => onOpen(row.id)}
          onKeyDown={(event) => event.key === "Enter" && onOpen(row.id)}
          className="mx-1 flex cursor-pointer flex-col gap-1 rounded-control px-2 py-1.5 text-sm hover:bg-fill-subtle focus-visible:focus-ring"
        >
          <span className="flex items-center gap-2">
            <RowMark mark={markOf(row)} label={statusWords(row) ?? ""} />
            <span title={title} className={cx("min-w-0 flex-1 truncate", closed(row) ? "text-marker-foreground" : "text-foreground")}>
              {title}
            </span>
            <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">{shortAgo(row, now)}</span>
            <MenuButton title={title} items={items} />
          </span>
          <Labels row={row} className="flex flex-wrap gap-1" />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>{items}</ContextMenuContent>
    </ContextMenu>
  );
}
