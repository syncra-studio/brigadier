import { useEffect, useState } from "react";

import { Button } from "../components/button";
import { ConfirmForm } from "../components/confirm-dialog";
import { Dialog, DialogContent } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { DropdownMenuItem } from "../components/menu";
import { EmptyState } from "../components/empty-state";
import { NavList, NavSection } from "../components/nav";
import { showToast } from "../components/toast";
import { ask } from "../daemon";
import { Archive, Trash, Unarchive } from "../icons";
import { errorText, run, store } from "../onboarding/api";
import type { Project } from "../sidebar/words";
import { restore } from "../sidebar/actions";
import { ArchivedActions } from "../sidebar/flyout";
import { SessionRowItem } from "../sidebar/row";
import { useStored } from "../sidebar/sidebar";
import type { SessionRow } from "../sidebar/words";
import { plural } from "../projects/remove";
import { hideDeleting } from "./archive";

/*
 * The docked Archived section, below the list [D191, D198]: folded at first, shown once something is
 * archived. Its rows open read-only; their menu has Restore and Delete, as every live row's menu has Delete [D3101].
 */

const titleOf = (row: { title: string }) => row.title || "New session";

export function ArchivedSection({
  rows,
  projects,
  active,
  offline,
  onOpen,
}: {
  rows: SessionRow[];
  projects: Project[];
  active: string | null;
  offline: boolean;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useStored("sidebar.archived", false);
  const projectOf = new Map(projects.map((project) => [project.id, project]));
  if (rows.length === 0) return null;
  return (
    <div className="flex max-h-2/5 min-h-0 shrink-0 flex-col px-2 pt-1 pb-2">
      <NavSection
        title="Archived"
        open={open}
        onOpenChange={setOpen}
        scrollList
        steadyChevron
        steadyActions
        actions={
          <ArchivedActions count={rows.length} />
        }
      >
        <NavList className="gap-1">
          {rows.map((row) => (
            <SessionRowItem
              key={row.id}
              row={row.lifecycle?.left ? { ...row, mark: "amber" } : row}
              project={row.project === null ? undefined : projectOf.get(row.project)}
              active={row.id === active}
              offline={offline}
              badged
              onOpen={onOpen}
              onRename={() => {}}
              menu={<ClosedMenuItems row={row} />}
            />
          ))}
        </NavList>
      </NavSection>
    </div>
  );
}

/** An archived row's menu, or one a delete left unfinished: what stayed, Restore, and Delete again [D35]. */
export function ClosedMenuItems({ row }: { row: SessionRow }) {
  const left = row.lifecycle?.left;
  return (
    <>
      {left && (
        <DropdownMenuItem disabled className="max-w-80 whitespace-normal">
          Couldn't delete everything: {left[0]}
        </DropdownMenuItem>
      )}
      {row.archived && (
        <DropdownMenuItem onClick={() => restore(row)}>
          <Unarchive />
          Restore
        </DropdownMenuItem>
      )}
      <DeleteMenuItem row={row} />
    </>
  );
}

const deleting = store<Deleted[] | null>(null);
const askDelete = (row: Deleted) => deleting.set([row]);

export function DeleteMenuItem({ row }: { row: SessionRow }) {
  return (
    <DropdownMenuItem variant="destructive" onClick={() => askDelete(row)}>
      <Trash />
      Delete
    </DropdownMenuItem>
  );
}

/** Where delete's confirm shows, mounted once by the sidebar, for every row menu's Delete [D3101]. */
export function DeleteAsk() {
  const asking = deleting.use();
  return (
    <Dialog open={asking !== null} onOpenChange={(next) => !next && deleting.set(null)}>
      <DialogContent showCloseButton={false}>{asking && <DeleteForm key={asking[0]!.id} rows={asking} onClose={() => deleting.set(null)} />}</DialogContent>
    </Dialog>
  );
}

type Deleted = { id: string; title: string };

/**
 * Delete's confirm, for one session or several [D35]: one line, as rivals' and Remove project's. Delete keeps a
 * branch with work that never landed [D181]; Rust's check only adds the workers it stops, and Delete doesn't wait
 * for it. Each row leaves at once and comes back if it fails, with delete's own reason.
 */
export function DeleteForm({ rows, onClose }: { rows: Deleted[]; onClose: () => void }) {
  const [running, setRunning] = useState(0);
  useEffect(() => {
    let live = true;
    const mine = new Set(rows.map((row) => row.id));
    run(["delete", ...mine, "--check"]).then(
      (reply) => live && setRunning((reply.running as string[]).filter((id) => !mine.has(id)).length),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [rows]);
  const one = rows.length === 1 ? rows[0]! : null;
  const many = `${rows.length} sessions`;
  const stop = running > 0 ? ` ${one ? "Its" : "Their"} ${plural(running, "running worker stops", "running workers stop")}.` : "";
  const confirm = () => {
    onClose();
    for (const row of rows) {
      hideDeleting(row.id, true);
      ask({ op: "run", args: ["delete", row.id, "--branch", "keep"] }, (reply) => {
        if (reply.ok) return;
        hideDeleting(row.id, false);
        const why = reply.left?.[0] ?? (reply.error === "disconnected" ? "Brigadier isn't running" : (reply.message ?? reply.error ?? "it failed"));
        showToast(`Couldn't delete “${titleOf(row)}”: ${why}`, { tone: "error" });
      });
    }
  };
  return (
    <ConfirmForm
      title={one ? `Delete “${titleOf(one)}”?` : `Delete ${many}?`}
      description={`This can't be undone.${stop}`}
      confirm={one ? "Delete session" : `Delete ${many}`}
      destructive
      onConfirm={confirm}
      onCancel={onClose}
    />
  );
}

/**
 * An archived session in its thread's place (D487): what it is, and Restore, which brings back its worktree too
 * [D180]; restoring, then the thread itself once Rust's row says it's back, or why it couldn't.
 */
export function ArchivedPage({ row }: { row: SessionRow }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = busy || row.lifecycle?.op === "restore";
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6">
      <EmptyState
        variant="centered"
        icon={Archive}
        title="This conversation is archived"
        detail={pending ? "Restoring it and its worktree…" : "Restore it to read it and go on."}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => {
          setBusy(true);
          setError(null);
          run(["restore", row.id]).then(
            () => setBusy(false),
            (cause) => {
              setBusy(false);
              setError(errorText(cause));
            },
          );
        }}
      >
        {pending ? "Restoring…" : "Restore"}
      </Button>
      <div role="alert">
        <ErrorLine error={error && `Couldn’t restore it: ${error}`} />
      </div>
    </div>
  );
}
