import { useEffect, useState } from "react";

import { Button } from "../components/button";
import { ConfirmForm } from "../components/confirm-dialog";
import { Dialog, DialogContent } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { DropdownMenuItem } from "../components/menu";
import { NavList, NavSection } from "../components/nav";
import { Radio, RadioGroup } from "../components/radio";
import { showToast } from "../components/toast";
import { ask } from "../daemon";
import { Trash, Unarchive } from "../icons";
import { errorText, run } from "../onboarding/api";
import type { Project } from "../sidebar/words";
import { restore } from "../sidebar/actions";
import { SessionRowItem } from "../sidebar/row";
import { useStored } from "../sidebar/sidebar";
import type { SessionRow } from "../sidebar/words";
import { hideDeleting } from "./archive";

/*
 * The docked Archived section, below the list [D191, D198]: folded at first, shown once something is
 * archived. Its rows open read-only; their menu has Restore and Delete…, the only place delete is.
 */

const titleOf = (row: SessionRow) => row.title || "New session";

export function ArchivedSection({
  rows,
  projects,
  active,
  offline,
  onOpen,
  storeKey = "sidebar",
}: {
  rows: SessionRow[];
  projects: Project[];
  active: string | null;
  offline: boolean;
  onOpen: (id: string) => void;
  storeKey?: string;
}) {
  const [open, setOpen] = useStored(`${storeKey}.archived`, false);
  const [asking, setAsking] = useState<SessionRow | null>(null);
  const projectOf = new Map(projects.map((project) => [project.id, project]));
  if (rows.length === 0 && !asking) return null;
  return (
    <div className="flex max-h-2/5 min-h-0 shrink-0 flex-col border-t border-border px-2 pt-2">
      <NavSection
        title="Archived"
        open={open}
        onOpenChange={setOpen}
        scrollList
        steadyEnd={<span className="text-xs text-muted-foreground tabular-nums">{rows.length}</span>}
      >
        <NavList className="gap-1">
          {rows.map((row) => {
            const left = row.lifecycle?.left;
            return (
              <SessionRowItem
                key={row.id}
                row={left ? { ...row, mark: "amber" } : row}
                project={row.project === null ? undefined : projectOf.get(row.project)}
                tone={projects.findIndex((project) => project.id === row.project)}
                active={row.id === active}
                offline={offline}
                badged
                onOpen={onOpen}
                onRename={() => {}}
                menu={
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
                    <DropdownMenuItem variant="destructive" onClick={() => setAsking(row)}>
                      <Trash />
                      Delete…
                    </DropdownMenuItem>
                  </>
                }
              />
            );
          })}
        </NavList>
      </NavSection>
      <Dialog open={asking !== null} onOpenChange={(next) => !next && setAsking(null)}>
        <DialogContent showCloseButton={false}>{asking && <DeleteForm row={asking} onClose={() => setAsking(null)} />}</DialogContent>
      </Dialog>
    </div>
  );
}

type Check = { state: "checking" } | { state: "done"; branch: string | null } | { state: "failed"; error: string };

/**
 * Delete's confirm [D35, D181]: a branch with work that never landed is named, kept unless asked. Delete
 * waits for Rust's check; Rust checks again as it runs. The row leaves at once and comes back if it fails.
 */
export function DeleteForm({ row, onClose, check: given }: { row: SessionRow; onClose: () => void; check?: Check }) {
  const [check, setCheck] = useState<Check>(given ?? { state: "checking" });
  const [drop, setDrop] = useState("keep");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (given) return;
    let live = true;
    setCheck({ state: "checking" });
    run(["delete", row.id, "--check"]).then(
      (reply) => live && setCheck({ state: "done", branch: reply.branch ?? null }),
      (cause) => live && setCheck({ state: "failed", error: errorText(cause) }),
    );
    return () => {
      live = false;
    };
  }, [row.id, attempt, given]);
  const confirm = () => {
    onClose();
    hideDeleting(row.id, true);
    const branch = check.state === "done" && check.branch && drop === "delete" ? "delete" : "keep";
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
      {check.state === "done" && check.branch && (
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

/** Restores from inside an archived session's thread, as the old app's bar did. */
export function ArchivedBar({ row }: { row: SessionRow }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = busy || row.lifecycle?.op === "restore";
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-3">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        Archived. Restore it to continue.
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
      </div>
      <div role="alert">
        <ErrorLine error={error} />
      </div>
    </div>
  );
}
