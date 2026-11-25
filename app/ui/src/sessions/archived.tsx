import { useEffect, useState } from "react";

import { Button } from "../components/button";
import { ConfirmForm } from "../components/confirm-dialog";
import { Dialog, DialogContent } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { DropdownMenuItem } from "../components/menu";
import { EmptyState } from "../components/empty-state";
import { NavList, NavSection } from "../components/nav";
import { Radio, RadioGroup } from "../components/radio";
import { named } from "../components/thread/rewind";
import { showToast } from "../components/toast";
import { ask, useDaemon, useFolderChat } from "../daemon";
import { Archive, Trash, Unarchive } from "../icons";
import { errorText, run, store } from "../onboarding/api";
import type { Project } from "../sidebar/words";
import { restore } from "../sidebar/actions";
import { ArchivedActions } from "../sidebar/flyout";
import { SessionRowItem } from "../sidebar/row";
import { useStored } from "../sidebar/sidebar";
import type { SessionRow } from "../sidebar/words";
import { type ArchiveCheck, hideDeleting } from "./archive";

/*
 * The docked Archived section, below the list [D191, D198]: folded at first, shown once something is
 * archived. Its rows open read-only; their menu has Restore and Delete, as every live row's menu has Delete [D3101].
 */

const titleOf = (row: SessionRow) => row.title || "New session";

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
  // Off for a folder chat, archived too [D3102].
  const folder = useFolderChat(row.id);
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
      {!folder && <DeleteMenuItem row={row} />}
    </>
  );
}

const deleting = store<{ row: SessionRow; check: Check } | null>(null);
/** Opens delete's confirm once Rust's check is in, so it opens whole [D463]. */
export const askDelete = (row: SessionRow) => void readDelete(row.id).then((check) => deleting.set({ row, check }));

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
      <DialogContent showCloseButton={false}>{asking && <DeleteForm key={asking.row.id} row={asking.row} first={asking.check} onClose={() => deleting.set(null)} />}</DialogContent>
    </Dialog>
  );
}

/** `stays`: another session still works in its folder, which stays [D1080]. `running`, `lost`: as archive's [D1197]. */
/** `workers`: its workers' branches with work that never landed, deleted with it under the one choice [D3017]. */
/** `kept`: its branch with such work that delete leaves whatever is picked, and why [D703]. */
export type Check =
  | { state: "checking" }
  | ({ state: "done"; branch: string | null; kept?: Kept | null; stays?: string | null; workers?: { id: string; title: string; branch: string }[] } & Partial<ArchiveCheck>)
  | { state: "failed"; error: string };
type Kept = { branch: string; why: "pr" | "shared" };

/** Rust's delete check, read before its confirm opens, so the confirm opens whole and never grows after [D463]. */
export const readDelete = (id: string): Promise<Check> =>
  run(["delete", id, "--check"]).then(
    (reply) => ({ state: "done", branch: reply.branch ?? null, kept: reply.kept ?? null, stays: reply.stays ?? null, running: reply.running ?? [], lost: reply.lost ?? [], workers: reply.workers ?? [] }),
    (cause) => ({ state: "failed", error: errorText(cause) }),
  );

/**
 * Delete's confirm [D35, D181]: a branch with work that never landed is named, kept unless asked. Delete
 * waits for Rust's check; Rust checks again as it runs. The row leaves at once and comes back if it fails.
 */
export function DeleteForm({ row, first, onClose }: { row: SessionRow; first: Check; onClose: () => void }) {
  const [check, setCheck] = useState<Check>(first);
  const { rows } = useDaemon();
  const [drop, setDrop] = useState("keep");
  const [attempt, setAttempt] = useState(0);
  // Read again on Retry; the first read came with it.
  useEffect(() => {
    if (!attempt) return;
    let live = true;
    setCheck({ state: "checking" });
    void readDelete(row.id).then((next) => live && setCheck(next));
    return () => {
      live = false;
    };
  }, [row.id, attempt]);
  const confirm = () => {
    onClose();
    hideDeleting(row.id, true);
    const branch = check.state === "done" && (check.branch || check.workers?.length) && drop === "delete" ? "delete" : "keep";
    ask({ op: "run", args: ["delete", row.id, "--branch", branch] }, (reply) => {
      if (reply.ok) return;
      hideDeleting(row.id, false);
      const why = reply.left?.[0] ?? (reply.error === "disconnected" ? "Brigadier isn't running" : (reply.message ?? reply.error ?? "it failed"));
      showToast(`Couldn't delete “${titleOf(row)}”: ${why}`, { tone: "error" });
    });
  };
  return (
    <ConfirmForm
      title="Delete session?"
      description={`This permanently deletes “${titleOf(row)}”. This can't be undone.`}
      confirm="Delete session"
      destructive
      disabled={check.state !== "done"}
      onConfirm={confirm}
      onCancel={onClose}
    >
      {check.state === "checking" && <p className="text-xs text-muted-foreground">Checking its branch…</p>}
      {check.state === "failed" && (
        <div className="flex items-center gap-2">
          <ErrorLine error={`Couldn't check its branch: ${check.error}`} />
          <Button variant="ghost" size="sm" onClick={() => setAttempt(attempt + 1)}>
            Retry
          </Button>
        </div>
      )}
      {check.state === "done" && (check.running?.length ?? 0) > 0 && <p className="text-xs text-muted-foreground">Its agent is working and will be stopped.</p>}
      {check.state === "done" &&
        check.lost?.map((each) =>
          each.files ? (
            <p key={each.ids.join()} className="text-xs break-words text-muted-foreground">
              Its ignored files are deleted for good: <span className="text-foreground">{named(each.files)}</span>.
            </p>
          ) : (
            <ErrorLine key={each.ids.join()} error={`Couldn't list its ignored files: ${each.error}`} />
          ),
        )}
      {check.state === "done" && check.stays && (
        <p className="text-xs text-muted-foreground">Its folder stays: {rows?.find((each) => each.id === check.stays)?.title ?? "another session"} still works there.</p>
      )}
      {check.state === "done" && <KeptBranches kept={check.kept ? [check.kept] : []} />}
      {check.state === "done" && (check.workers?.length ?? 0) > 0 && (
        <FamilyBranches branches={[...(check.branch ? [{ branch: check.branch, title: titleOf(row) }] : []), ...check.workers!]} drop={drop} setDrop={setDrop} />
      )}
      {check.state === "done" && check.branch && !check.workers?.length && (
        <div className="flex flex-col gap-2.5">
          <p className="text-xs text-muted-foreground">
            Its branch <code className="font-mono text-foreground">{check.branch}</code> has work that never landed.
          </p>
          <RadioGroup value={drop} onValueChange={(value) => setDrop(String(value))} className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm">
              <Radio value="keep" />
              Keep branch
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Radio value="delete" />
              Delete it too
            </label>
          </RadioGroup>
        </div>
      )}
    </ConfirmForm>
  );
}

/** Branches delete leaves whatever is picked [D703]: a pull request's, or one another session uses; one line each. */
export function KeptBranches({ kept }: { kept: Kept[] }) {
  const why = new Map(kept.map((each) => [each.branch, each.why]));
  if (!why.size) return null;
  return (
    <div className="flex flex-col gap-1 text-xs break-words text-muted-foreground">
      {[...why].map(([branch, reason]) => (
        <p key={branch}>
          <code className="font-mono text-foreground">{branch}</code> stays either way: {reason === "pr" ? "it's a pull request's branch." : "another session uses it."}
        </p>
      ))}
    </div>
  );
}

/** A session and its workers' branches with work that never landed, in DeleteManyForm's words: one choice for all. */
function FamilyBranches({ branches, drop, setDrop }: { branches: { branch: string; title: string }[]; drop: string; setDrop: (drop: string) => void }) {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-xs text-muted-foreground">{branches.length === 1 ? "This branch has" : "These branches have"} work that never landed:</p>
      <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
        {branches.map(({ branch, title }) => (
          <li key={branch} className="truncate">
            <code className="font-mono text-foreground">{branch}</code> · {title || "New session"}
          </li>
        ))}
      </ul>
      <RadioGroup value={drop} onValueChange={(value) => setDrop(String(value))} className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <Radio value="keep" />
          {branches.length === 1 ? "Keep branch" : "Keep branches"}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Radio value="delete" />
          {branches.length === 1 ? "Delete it too" : "Delete them too"}
        </label>
      </RadioGroup>
    </div>
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
