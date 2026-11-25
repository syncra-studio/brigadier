import { type ReactNode, useEffect } from "react";

import { ConfirmForm } from "../components/confirm-dialog";
import { Dialog, DialogContent } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { DropdownMenuItem, DropdownMenuShortcut } from "../components/menu";
import { RowAction } from "../components/row-action";
import { named } from "../components/thread/rewind";
import { toastManager } from "../components/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Archive } from "../icons";
import { useDaemon } from "../daemon";
import { errorText, run, store } from "../onboarding/api";
import { keysOf, matches } from "../shortcuts";
import { archive, restore } from "../sidebar/actions";
import type { SessionRow } from "../sidebar/words";

/*
 * Archive from anywhere, at once, with Undo and ⌘Z [D180, D185, D198], as the old app did: the row menu,
 * ⇧⌘A (the picked rows, else the open one) and ⌘⌫ (the picked rows). ⌘-click and Shift-click pick
 * several. Rust does the work behind the sidebar's queue, which shows each change until its row has it.
 */

/** How long Undo stays, as in the old app. */
const UNDO_MS = 4000;

const picked = store<SessionRow[]>([]);
let anchor: string | null = null;
export const usePicked = picked.use;
export const clearPicked = () => picked.set([]);

/** A row's click: ⌘ toggles it into the pick, Shift picks the range from the last one clicked (or the open one), a plain click clears the pick and opens it. */
export function clickRow(event: { metaKey: boolean; shiftKey: boolean }, row: SessionRow, order: SessionRow[], active: string | null, onOpen: (id: string) => void) {
  if (event.metaKey) {
    const now = picked.get();
    picked.set(now.some((each) => each.id === row.id) ? now.filter((each) => each.id !== row.id) : [...now, row]);
    anchor = row.id;
    return;
  }
  const from = order.findIndex((each) => each.id === (anchor ?? active));
  if (event.shiftKey && from >= 0) {
    const to = order.findIndex((each) => each.id === row.id);
    picked.set(order.slice(Math.min(from, to), Math.max(from, to) + 1));
    return;
  }
  clearPicked();
  anchor = row.id;
  onOpen(row.id);
}

let undo: (() => void) | null = null;
let undoFocus: Element | null = null;
let typedSinceArchive = false;
/** The open session and the way Home, kept by `useArchiveKeys`. */
let view: { active: string | null; onHome: () => void } = { active: null, onHome: () => {} };

/**
 * Rust's check before archiving [D1197]: whose agent is working, and per folder the batch frees, the ignored files
 * it deletes for good (or why they couldn't be listed).
 */
export type ArchiveCheck = { running: string[]; lost: Lost[]; with?: Record<string, string[]> };
/** `repos`: a delete's, the repositories in what it takes. */
export type Lost = { ids: string[]; files?: string[]; repos?: string[]; error?: string };
type Asking = { rows: SessionRow[]; focus: Element | null; check?: ArchiveCheck; error?: string };
const asking = store<Asking | null>(null);
/** Rows Rust checks or the confirm asks about: hidden at once [D198], back on Cancel or a failed check. */
const pending = new Set<string>();
function hold(rows: SessionRow[], on: boolean) {
  for (const row of rows) {
    if (on) pending.add(row.id);
    else pending.delete(row.id);
    hideDeleting(row.id, on);
  }
}
/** A confirm another check's would replace is its Cancel. */
function ask(next: Asking) {
  const was = asking.get();
  if (was) hold(was.rows, false);
  asking.set(next);
}

/**
 * Archives the rows; an open one goes Home. Rust checks the batch first: with nothing to say it goes at once, with
 * Undo (and ⌘Z while it shows) [D198]; else the confirm says it first [D1197].
 */
export function archiveRows(chosen: SessionRow[]) {
  // A row already under way isn't checked twice, so a stale answer can't archive it again after an Undo.
  const rows = chosen.filter((row) => !pending.has(row.id));
  if (rows.length === 0) return;
  hold(rows, true);
  const focus = document.activeElement;
  let asked = false;
  run(["archive", ...rows.map((row) => row.id), "--check"])
    .then(
      (reply) => {
        const check = { running: reply.running ?? [], lost: reply.lost ?? [], with: reply.with ?? {} };
        if (check.running.length + check.lost.length === 0) return archiveNow(rows, focus, check);
        ask({ rows, focus, check });
        asked = true;
      },
      (cause) => ask({ rows, focus, error: errorText(cause) }),
    )
    .finally(() => !asked && hold(rows, false));
}

/** How many sessions go with the rows' Brigades [D3111]. */
const withCount = (check?: ArchiveCheck) => Object.values(check?.with ?? {}).flat().length;
const theirs = (count: number, owner = "its") => (count === 1 ? `${owner} session` : `${owner} ${count} sessions`);

function archiveNow(rows: SessionRow[], focus: Element | null, check?: ArchiveCheck) {
  const { active, onHome } = view;
  undoFocus = focus;
  typedSinceArchive = false;
  clearPicked();
  for (const row of rows) archive(row);
  if (rows.some((row) => row.id === active)) onHome();
  const back = () => {
    undo = null;
    toastManager.close(id);
    for (const row of rows) restore(row);
  };
  undo = back;
  const id = toastManager.add({
    title: rows.length > 1 ? `Archived ${rows.length + withCount(check)} sessions` : withCount(check) ? `Archived ${titleOf(rows[0])} and ${theirs(withCount(check))}` : "Archived session",
    type: "neutral",
    timeout: UNDO_MS,
    data: { actions: [{ label: "Undo", run: back }] },
    onClose: () => undo === back && (undo = null),
  });
}

const titleOf = (row: SessionRow | undefined) => `“${row?.title || "New session"}”`;

/** What one folder loses for good, in archive's and delete's confirm, or why it couldn't be listed. */
export function LostLine({ lost: { files, repos, error }, whose, more = "" }: { lost: Lost; whose: string; more?: string }) {
  if (error !== undefined) return <ErrorLine error={`${whose}Couldn't list its ignored files: ${error}`} />;
  return (
    <p className="text-xs break-words text-muted-foreground">
      {whose}
      {repos ? (
        <>
          {repos.length === 1 ? "The repository in it is" : "The repositories in it are"} deleted for good, even if a branch is kept: <span className="text-foreground">{repos.join(", ")}</span>.
        </>
      ) : (
        <>
          Its ignored files are deleted for good{more}: <span className="text-foreground">{named(files ?? [])}</span>.
        </>
      )}
    </p>
  );
}

/** The lines under a confirm's question, scrolling when there are many. */
export const ConfirmLines = ({ children }: { children: ReactNode }) => <div className="-m-1 flex max-h-confirm-lines flex-col gap-4 overflow-y-auto p-1 empty:hidden">{children}</div>;

/** Archive's confirm, from Rust's check (proposed words) [D179, D1197]. */
export function ArchiveForm({ rows, check, error, onConfirm, onCancel }: { rows: SessionRow[]; check?: ArchiveCheck; error?: string; onConfirm: () => void; onCancel: () => void }) {
  const one = rows.length === 1;
  // A Brigade's sessions going with it are named from the rows Rust sends [D3111].
  const all = useDaemon().rows as SessionRow[] | undefined;
  const byId = (id: string) => rows.find((row) => row.id === id) ?? all?.find((row) => row.id === id);
  const more = withCount(check);
  const lone = one && more === 0;
  const whose = (ids: string[]) => (lone ? "" : `${ids.map((id) => titleOf(byId(id))).join(", ")}: `);
  return (
    <ConfirmForm
      title={one ? "Archive session?" : `Archive ${rows.length} sessions?`}
      description={
        one && more
          ? `This archives ${titleOf(rows[0])} and ${theirs(more)}. Restore brings them back.`
          : one
            ? `This archives ${titleOf(rows[0])}. Restore brings it back.`
            : more
              ? `This archives them and ${theirs(more, "their")}. Restore brings each one back.`
              : "Restore brings each one back."
      }
      confirm="Archive"
      destructive={!!check?.lost.some((each) => each.files)}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <ConfirmLines>
        {(check?.running ?? []).map((id) => (
          <p key={id} className="text-xs text-muted-foreground">
            {lone ? "Its agent is working and will be stopped." : `${titleOf(byId(id))} is working; its agent will be stopped.`}
          </p>
        ))}
        {(check?.lost ?? []).map((each, at) => <LostLine key={at} lost={each} whose={whose(each.ids)} more=", and restore won't bring them back" />)}
        <ErrorLine error={error && `Couldn't check what archiving loses: ${error}`} />
      </ConfirmLines>
    </ConfirmForm>
  );
}

/** Where archive's confirm shows, mounted once by the sidebar. */
export function ArchiveAsk() {
  const now = asking.use();
  const close = () => {
    if (now) hold(now.rows, false);
    asking.set(null);
  };
  return (
    <Dialog open={now !== null} onOpenChange={(next) => !next && close()}>
      <DialogContent showCloseButton={false}>
        {now && (
          <ArchiveForm
            rows={now.rows}
            check={now.check}
            error={now.error}
            onConfirm={() => {
              archiveNow(now.rows, now.focus, now.check);
              close();
            }}
            onCancel={close}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A field that types text keeps ⌘⌫ for itself. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && (target as HTMLInputElement).type !== "checkbox"));

/** The archive keys and Esc, mounted once by the sidebar: `order` is its rows top to bottom. */
export function useArchiveKeys(order: SessionRow[], active: string | null, onHome: () => void) {
  view = { active, onHome };
  useEffect(() => {
    const onInput = () => { typedSinceArchive = true; };
    const onUndoKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matches(event, "undo-archive")) return;
      if (!undo || document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (typing(event.target) && (typedSinceArchive || event.target === undoFocus)) return;
      event.preventDefault();
      event.stopPropagation();
      undo();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Not behind a dialog or menu, where what it would archive can't be seen.
      const covered = document.querySelector('[role="dialog"], [role="menu"]') !== null;
      const field = typing(event.target);
      if (covered) return;
      if (matches(event, "clear-picked")) return void (field || clearPicked());
      const pick = picked.get();
      if (matches(event, "archive")) {
        event.preventDefault();
        archiveRows(pick.length > 0 ? pick : order.filter((row) => row.id === active));
      } else if (matches(event, "archive-picked") && !field && pick.length > 0) {
        event.preventDefault();
        archiveRows(pick);
      }
    };
    addEventListener("beforeinput", onInput, true);
    addEventListener("keydown", onUndoKey, true);
    addEventListener("keydown", onKeyDown);
    return () => {
      removeEventListener("beforeinput", onInput, true);
      removeEventListener("keydown", onUndoKey, true);
      removeEventListener("keydown", onKeyDown);
    };
  });
}

/** The row menu's Archive: the picked rows when this is one of several picked, else this one. */
/** What a row's Archive takes: the pick when the row is in it, else the row. */
function useArchiveTarget(row: SessionRow) {
  const pick = usePicked();
  const several = pick.length > 1 && pick.some((each) => each.id === row.id);
  return { rows: several ? pick : [row], label: several ? `Archive (${pick.length})` : "Archive session" };
}

export function ArchiveMenuItem({ row }: { row: SessionRow }) {
  const target = useArchiveTarget(row);
  return (
    <DropdownMenuItem onClick={() => archiveRows(target.rows)}>
      <Archive />
      {target.rows.length > 1 ? target.label : "Archive"}
      <DropdownMenuShortcut>{keysOf("archive")[0]}</DropdownMenuShortcut>
    </DropdownMenuItem>
  );
}

/** The same Archive on the row itself, beside its ⋯ and shown as it is. */
export function ArchiveRowAction({ row }: { row: SessionRow }) {
  const target = useArchiveTarget(row);
  return (
    <Tooltip>
      <TooltipTrigger render={<RowAction thread aria-label={target.label} onClick={() => archiveRows(target.rows)} />}>
        <Archive />
      </TooltipTrigger>
      <TooltipContent side="bottom">{target.label}</TooltipContent>
    </Tooltip>
  );
}

const deleting = store<ReadonlySet<string>>(new Set());
export const hideDeleting = (id: string, on: boolean) => {
  const next = new Set(deleting.get());
  if (on) next.add(id);
  else next.delete(id);
  deleting.set(next);
};

/** Archived, or a delete that left something: among the archived, not the live rows. */
export const closed = (row: SessionRow) => Boolean(row.archived) || row.lifecycle?.op === "delete";

/**
 * The live rows and the archived ones. A delete under way is hidden; one that left something comes back
 * among the archived with what stayed (Rust's `lifecycle.left`) [D35].
 */
export function useArchiveSplit(rows: SessionRow[] | undefined): { live: SessionRow[] | undefined; archived: SessionRow[] } {
  const gone = deleting.use();
  const shown = rows?.filter((row) => !gone.has(row.id) && !(row.lifecycle?.op === "delete" && !row.lifecycle.left));
  return { live: shown?.filter((row) => !closed(row)), archived: (shown ?? []).filter(closed).toSorted((a, b) => (b.archived ?? 0) - (a.archived ?? 0)) };
}
